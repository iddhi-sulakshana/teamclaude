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
// typeface (Geist) is embedded rather than fetched, for the same reason. All
// rendering uses textContent — status fields (account names, client names) are
// operator/OAuth-derived, but they still never reach innerHTML.

import { createHash } from 'node:crypto';
import { UNAVAILABLE_TEXT, RESET_CREDIT_MAX_AGE_MS } from './status-renderer.js';
import { USAGE_WINDOWS } from './client-usage.js';
import { formatMoney } from './oauth.js';
import { resolveMaxSpendMinor, spendCapReached } from './model.js';
import { GEIST_WOFF2, GEIST_MONO_WOFF2 } from './dashboard-fonts.js';

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
    // The two Geist faces, inlined into the page's own stylesheet as data:
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

// The usage-over-time chart, from GET /teamclaude/usage/series: one bar per
// bucket of the window shown — the last five for `5h`, the whole day for `24h`
// and for `total`, which has no series of its own (the chart says so) — each
// stacked by client. The two biggest clients over the shown range get a
// segment of their own and the rest share one, which is what the legend can
// name without turning into a second table. `parts` are in legend order, so a
// bar's bottom segment is always the biggest client's.
/**
 * @param {any} series
 * @param {string} [view]
 * @param {string} [metric]
 */
export function seriesBars(series, view, metric) {
  var s = series || {};
  var n = Number.isInteger(s.buckets) && s.buckets > 0 ? s.buckets : 0;
  var bucketMs = s.bucketMs || 0;
  var shown = view === '5h' && bucketMs ? Math.min(n, Math.max(1, Math.round(5 * 3600000 / bucketMs))) : n;
  var from = n - shown;
  var clients = s.clients || {};
  var at = function (/** @type {any} */ c, /** @type {number} */ i) {
    if (metric === 'requests') return (c.requests || [])[i] || 0;
    return ((c.inputTokens || [])[i] || 0) + ((c.outputTokens || [])[i] || 0);
  };
  var ranked = Object.keys(clients).map(function (name) {
    var sum = 0;
    for (var i = from; i < n; i++) sum += at(clients[name], i);
    return { name: name, sum: sum };
  }).filter(function (r) { return r.sum > 0; });
  ranked.sort(function (x, y) { return (y.sum - x.sum) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0); });
  var legend = ranked.slice(0, 2).map(function (r) { return r.name; });
  var rest = ranked.slice(2).map(function (r) { return r.name; });
  var bars = [], peak = 0, total = 0;
  for (var i = from; i < n; i++) {
    var parts = legend.map(function (name) { return at(clients[name], i); });
    var others = 0;
    rest.forEach(function (name) { others += at(clients[name], i); });
    var sum = others;
    parts.forEach(function (v) { sum += v; });
    bars.push({ start: s.end - (n - i) * bucketMs, end: s.end - (n - 1 - i) * bucketMs, parts: parts, others: others, total: sum });
    if (sum > peak) peak = sum;
    total += sum;
  }
  return { bars: bars, legend: legend, hasOthers: rest.length > 0, peak: peak, total: total, spanMs: shown * bucketMs };
}

// The chart's axis labels, oldest first and ending at "now": every hour for a
// span of six hours or less, every quarter of the span beyond that.
/** @param {number} spanMs */
export function seriesTicks(spanMs) {
  var hours = Math.round((spanMs || 0) / 3600000);
  if (hours <= 0) return [];
  var step = hours <= 6 ? 1 : Math.max(1, Math.round(hours / 4));
  var out = [];
  for (var h = hours; h > 0; h -= step) out.push('-' + h + 'h');
  out.push('now');
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

// Whether the caller the status payload names may use one of the page's
// controls, mirroring the server's gates (controlRole in server.js) so a button
// is offered only where it would be honoured. `action` is 'switch', 'reload',
// 'probe', 'accounts' (enable/disable and priority) or 'threshold'. A server
// older than `viewer` sends none, and every control shows as it always did —
// the server's 403 still has the final word either way.
/** @param {{ role?: string }|null|undefined} viewer @param {string} action */
export function viewerCan(viewer, action) {
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
  scopedWeeklyRows, accountTokens, providerLabel, thresholdBadgeText, accountBadges, sessionRows, filterSessionRows, sortRows, uniqSorted,
  switchRequest, switchOutcome, accountControlRequest, accountControlOutcome, thresholdRequest, thresholdPercentText, thresholdOutcome, routeRows, problems, usageFor,
  clientRanking, viewerCan, loginStartRequest, loginFinishRequest, loginOutcome,
  formatMoney, resolveMaxSpendMinor, spendCapReached, extraUsageText, extraUsageBar, meterTone, seriesBars, seriesTicks,
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

// The dark palette is the design's own and the default; the light one is the
// same system with the values turned over. Both are defined twice for the
// same reason as before: once under the media query, for a viewer who has
// stored no choice, and once under the attribute, for one who has. The media
// rule excludes an explicit dark choice, so choosing dark on a light desktop is
// honoured rather than overridden by the system.
const DARK_TOKENS = `
    color-scheme: dark;
    --bg: #0B0C0E; --glow: rgba(217,119,87,0.10); --panel: #111215; --raised: #15161A; --raised-2: #1A1B1F;
    --raised-hover: #1C1D22; --modal: #131417; --field: #0B0C0E;
    --line: rgba(255,255,255,0.07); --line-btn: rgba(255,255,255,0.09); --line-strong: rgba(255,255,255,0.1);
    --line-mid: rgba(255,255,255,0.08); --line-soft: rgba(255,255,255,0.06); --row-line: rgba(255,255,255,0.04);
    --text: #ECECEE; --text-strong: #FFFFFF; --text-2: #D4D5D9; --muted: #B5B7BD; --dim: #8B8D94; --faint: #6F727A; --placeholder: #5D6068;
    --chip: rgba(255,255,255,0.06); --track: rgba(255,255,255,0.05); --sel: #2A2B31; --hover-soft: rgba(255,255,255,0.06);
    --hover-faint: rgba(255,255,255,0.03); --seg-off: rgba(255,255,255,0.1); --toggle-off: rgba(255,255,255,0.12);
    --grid: rgba(255,255,255,0.04); --axis: rgba(255,255,255,0.08);
    --accent: oklch(0.7 0.14 45); --accent-hover: oklch(0.76 0.13 48); --on-accent: #1A0F0A; --logo: oklch(0.68 0.14 42);
    --accent-soft: rgba(217,119,87,0.16); --accent-text: oklch(0.82 0.12 50); --accent-line: rgba(217,119,87,0.4); --link: oklch(0.78 0.13 50);
    --series-1: oklch(0.7 0.14 45); --series-2: oklch(0.55 0.08 45); --series-other: #3A3C43; --share-2: oklch(0.62 0.1 45);
    --ok: oklch(0.72 0.15 150); --ok-text: oklch(0.78 0.15 150); --ok-ring: rgba(80,200,120,0.15);
    --warn: oklch(0.8 0.14 80); --warn-text: oklch(0.84 0.13 80); --warn-soft: rgba(230,180,60,0.08); --warn-line: rgba(230,180,60,0.25);
    --bad: oklch(0.66 0.19 25); --bad-text: #FF9A88; --bad-soft: rgba(255,100,80,0.12); --bad-line: rgba(255,100,80,0.3);
    --scrim: rgba(5,5,7,0.72); --shadow: 0 30px 80px rgba(0,0,0,0.6);
    --av-l: 0.35; --av-c: 0.06; --av-fg-l: 0.9;`;

const LIGHT_TOKENS = `
    color-scheme: light;
    --bg: #F6F5F2; --glow: rgba(217,119,87,0.12); --panel: #FFFFFF; --raised: #FFFFFF; --raised-2: #F3F2EF;
    --raised-hover: #EFEEEA; --modal: #FFFFFF; --field: #F6F5F2;
    --line: rgba(20,20,30,0.09); --line-btn: rgba(20,20,30,0.12); --line-strong: rgba(20,20,30,0.14);
    --line-mid: rgba(20,20,30,0.1); --line-soft: rgba(20,20,30,0.07); --row-line: rgba(20,20,30,0.05);
    --text: #17181B; --text-strong: #000000; --text-2: #2B2C31; --muted: #4B4D54; --dim: #5F626A; --faint: #7C7F87; --placeholder: #9A9CA3;
    --chip: rgba(20,20,30,0.05); --track: rgba(20,20,30,0.07); --sel: #E8E6E1; --hover-soft: rgba(20,20,30,0.05);
    --hover-faint: rgba(20,20,30,0.03); --seg-off: rgba(20,20,30,0.12); --toggle-off: rgba(20,20,30,0.18);
    --grid: rgba(20,20,30,0.06); --axis: rgba(20,20,30,0.12);
    --accent: oklch(0.68 0.15 45); --accent-hover: oklch(0.63 0.15 45); --on-accent: #1A0F0A; --logo: oklch(0.68 0.14 42);
    --accent-soft: rgba(217,119,87,0.14); --accent-text: oklch(0.5 0.13 45); --accent-line: rgba(217,119,87,0.55); --link: oklch(0.52 0.14 45);
    --series-1: oklch(0.66 0.15 45); --series-2: oklch(0.8 0.08 50); --series-other: #D6D4CF; --share-2: oklch(0.76 0.09 48);
    --ok: oklch(0.64 0.15 150); --ok-text: oklch(0.48 0.13 150); --ok-ring: rgba(40,160,90,0.18);
    --warn: oklch(0.76 0.15 80); --warn-text: oklch(0.5 0.11 70); --warn-soft: rgba(210,160,40,0.12); --warn-line: rgba(200,150,30,0.35);
    --bad: oklch(0.6 0.2 25); --bad-text: oklch(0.5 0.18 25); --bad-soft: rgba(220,70,50,0.09); --bad-line: rgba(220,70,50,0.3);
    --scrim: rgba(30,30,36,0.35); --shadow: 0 30px 80px rgba(0,0,0,0.18);
    --av-l: 0.92; --av-c: 0.05; --av-fg-l: 0.42;`;

// The settings button's gear, as the design draws it (Feather's "settings").
const GEAR_PATH = 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeamClaude</title>
<style>
  @font-face { font-family: 'Geist'; src: url(data:font/woff2;base64,${GEIST_WOFF2}) format('woff2'); font-weight: 100 900; font-style: normal; font-display: swap; }
  @font-face { font-family: 'Geist Mono'; src: url(data:font/woff2;base64,${GEIST_MONO_WOFF2}) format('woff2'); font-weight: 100 900; font-style: normal; font-display: swap; }
  :root {${DARK_TOKENS}
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {${LIGHT_TOKENS}
    }
  }
  :root[data-theme="light"] {${LIGHT_TOKENS}
  }
  * { box-sizing: border-box; margin: 0; }
  html { background: var(--bg); }
  body { min-height: 100vh; background: radial-gradient(1200px 500px at 50% -200px, var(--glow), transparent 70%), var(--bg); color: var(--text); font: 14px/1.5 'Geist', ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  .mono, td.num, .chart-total, .ticks, .acct-foot, .meter-top .mv, .share .val, .rt-to, .rt-fam span, .stepper .val, #key { font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button { font: inherit; }
  input::placeholder { color: var(--placeholder); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 40px 28px 56px; }
  #app { display: flex; flex-direction: column; gap: 28px; }

  /* Header */
  .top { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 20px; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .logo { width: 40px; height: 40px; flex: none; border-radius: 11px; background: var(--logo); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 17px; color: var(--on-accent); letter-spacing: -0.02em; }
  .brand-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .title { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.2; }
  .who { font-size: 13px; color: var(--dim); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .who b { color: var(--text); font-weight: 500; }
  .pill { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: var(--chip); color: var(--muted); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .btn { height: 34px; padding: 0 14px; border-radius: 9px; border: 1px solid var(--line-btn); background: var(--raised); color: var(--text-2); font-size: 13px; cursor: pointer; white-space: nowrap; }
  .btn:hover { background: var(--raised-hover); color: var(--text-strong); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { border: none; background: var(--accent); color: var(--on-accent); font-weight: 600; padding: 0 15px; }
  .btn.primary:hover { background: var(--accent-hover); color: var(--on-accent); }
  .btn.sm { height: 30px; padding: 0 12px; border-radius: 8px; font-size: 12px; background: var(--raised-2); color: var(--text); }
  .btn.ghost { height: 28px; padding: 0 11px; border-radius: 7px; background: transparent; color: var(--muted); font-size: 12px; }
  .btn.ghost:hover { background: var(--hover-soft); color: var(--text-strong); }
  .btn.outline { height: 32px; padding: 0 13px; border-radius: 8px; border-color: var(--line-strong); background: transparent; }
  .btn.outline:hover { background: var(--hover-soft); }
  .btn.go { height: 32px; padding: 0 14px; border-radius: 8px; border: none; background: var(--accent); color: var(--on-accent); font-weight: 600; flex: none; }
  .btn.go:hover { background: var(--accent-hover); color: var(--on-accent); }

  /* Summary strip */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .stat { background: var(--panel); padding: 18px 20px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .stat.thr { padding: 14px 20px; }
  .stat .k { font-size: 12px; color: var(--dim); }
  .stat .v { font-size: 16px; font-weight: 500; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .stat .v.stack { flex-direction: column; align-items: flex-start; gap: 4px; font-size: 14px; }
  .stat .v .line { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
  .stat .v .sub { color: var(--dim); font-weight: 400; }
  #statConv { gap: 5px; }
  .live { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-ring); flex: none; }
  .live.none { background: var(--faint); box-shadow: none; }
  .ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .thr-row { display: flex; align-items: center; gap: 8px; }
  .field { display: flex; align-items: center; height: 30px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--field); padding: 0 10px; gap: 4px; }
  .field input { width: 44px; background: transparent; border: none; outline: none; color: var(--text); font: 14px 'Geist Mono', ui-monospace, monospace; text-align: right; -moz-appearance: textfield; appearance: textfield; }
  .field input::-webkit-inner-spin-button, .field input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .field span { color: var(--dim); font-size: 13px; }

  /* Messages */
  #problems { display: none; }
  .alert { border-radius: 10px; padding: 10px 14px; font-size: 13px; display: flex; gap: 10px; align-items: flex-start; border: 1px solid transparent; }
  .alert + .alert { margin-top: 8px; }
  .alert::before { content: ''; width: 6px; height: 6px; border-radius: 50%; margin-top: 7px; flex: none; background: currentColor; }
  .alert.bad { background: var(--bad-soft); color: var(--bad-text); border-color: var(--bad-line); }
  .alert.warn { background: var(--warn-soft); color: var(--warn-text); border-color: var(--warn-line); }
  #err { display: none; }
  #note { display: none; font-size: 12px; padding: 8px 12px; border-radius: 9px; background: var(--panel); border: 1px solid var(--line); color: var(--dim); }
  #note.ok, .set-note.ok { color: var(--ok-text); }
  #note.warn, .set-note.warn { color: var(--warn-text); }
  #note.error, .set-note.error { color: var(--bad-text); }

  /* Sections */
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 20px; align-items: start; }
  .sec { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .sec-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; min-height: 30px; }
  .sec-title-row { display: flex; align-items: baseline; gap: 10px; }
  .sec-title { font-size: 13px; font-weight: 500; color: var(--dim); letter-spacing: 0.01em; }
  .sec-count { font-size: 12px; color: var(--faint); }
  .panel { border-radius: 14px; border: 1px solid var(--line); background: var(--panel); min-width: 0; }
  .panel.pad { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
  .tools { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .seg { display: flex; padding: 3px; border-radius: 9px; background: var(--raised); border: 1px solid var(--line); gap: 2px; }
  .seg button { height: 24px; padding: 0 10px; border-radius: 6px; border: none; background: transparent; color: var(--dim); font-size: 12px; cursor: pointer; white-space: nowrap; }
  .seg button:hover { color: var(--text); }
  .seg button.sel { background: var(--sel); color: var(--text); }
  #dimViewSlot { display: none; justify-content: flex-end; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--dim); align-items: center; flex-wrap: wrap; }
  .legend span { display: flex; align-items: center; gap: 6px; }
  .sw { width: 8px; height: 8px; border-radius: 2px; flex: none; display: inline-block; }
  .sw.s0 { background: var(--series-1); } .sw.s1 { background: var(--series-2); } .sw.so { background: var(--series-other); }
  .sw.ok { background: var(--ok); } .sw.warn { background: var(--warn); } .sw.bad { background: var(--bad); }

  /* Usage over time */
  .chart-top { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
  .chart-id { display: flex; flex-direction: column; gap: 4px; }
  .chart-cap { font-size: 12px; color: var(--faint); }
  .chart-total { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.2; }
  .bars { position: relative; height: 150px; display: flex; align-items: flex-end; gap: 4px; border-bottom: 1px solid var(--axis); background: repeating-linear-gradient(to top, transparent 0, transparent 49px, var(--grid) 49px, var(--grid) 50px); }
  .col { flex: 1; height: 100%; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end; gap: 1px; border-radius: 3px 3px 0 0; overflow: hidden; opacity: .92; cursor: default; }
  .col:hover { opacity: 1; background: var(--hover-faint); }
  .col i { display: block; flex: none; }
  .col i.s0 { background: var(--series-1); } .col i.s1 { background: var(--series-2); } .col i.so { background: var(--series-other); }
  .bars-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--faint); text-align: center; padding: 0 12px; }
  .ticks { display: flex; justify-content: space-between; font-size: 11px; color: var(--faint); }

  /* Most used */
  .share-lead { font-size: 12px; color: var(--faint); }
  .shares { display: flex; flex-direction: column; gap: 14px; }
  .share { display: grid; grid-template-columns: 84px 1fr auto; gap: 14px; align-items: center; font-size: 13px; }
  .share .n { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track { height: 8px; border-radius: 4px; background: var(--track); overflow: hidden; }
  .track i { display: block; height: 100%; border-radius: 4px; background: var(--share-2); transition: width .4s ease; }
  .track i.top { background: var(--accent); }
  .share .val { font-size: 12px; color: var(--dim); min-width: 112px; text-align: right; white-space: nowrap; }
  .share .val b { color: var(--text); font-weight: 400; }
  .foot-note { font-size: 12px; color: var(--faint); line-height: 1.55; border-top: 1px solid var(--line-soft); padding-top: 14px; }

  /* Accounts */
  .acct-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); gap: 14px; }
  .acct { border-radius: 14px; border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; transition: opacity .2s; min-width: 0; }
  .acct.current { border-color: var(--accent-line); }
  .acct.off { opacity: .5; }
  .acct-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .acct-id { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .acct-name-row { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .avatar { width: 28px; height: 28px; flex: none; border-radius: 8px; background: oklch(var(--av-l) var(--av-c) var(--h, 45)); color: oklch(var(--av-fg-l) 0.06 var(--h, 45)); font-size: 12px; font-weight: 600; display: flex; align-items: center; justify-content: center; }
  .avatar.lg { width: 34px; height: 34px; border-radius: 9px; font-size: 14px; }
  .acct-name { font-size: 14.5px; font-weight: 600; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { font-size: 11px; line-height: 1; padding: 4px 7px; border-radius: 5px; background: var(--chip); color: var(--muted); white-space: nowrap; }
  .chip.current, .chip.provider { background: var(--accent-soft); color: var(--accent-text); }
  .chip.disabled, .chip.error, .chip.exhausted, .chip.extra-usage.billing { background: var(--bad-soft); color: var(--bad-text); }
  .chip.throttled, .chip.extra-usage { background: var(--warn-soft); color: var(--warn-text); }
  .gear { width: 30px; height: 30px; flex: none; border-radius: 8px; border: 1px solid var(--line-strong); background: transparent; color: var(--muted); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
  .gear:hover { background: var(--hover-soft); color: var(--text-strong); }
  .blocked { font-size: 12px; color: var(--warn-text); background: var(--warn-soft); border-radius: 8px; padding: 8px 10px; display: flex; align-items: center; gap: 8px; }
  .blocked::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--warn); flex: none; }
  .blocked.bad { color: var(--bad-text); background: var(--bad-soft); }
  .blocked.bad::before { background: var(--bad); }
  .meters { display: flex; flex-direction: column; gap: 11px; }
  .meter { display: flex; flex-direction: column; gap: 6px; }
  .meter-top { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
  .meter-top .lbl { color: var(--dim); }
  .meter-top .mv { color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meter-top .mv b { color: var(--text); font-weight: 400; }
  .mbar { height: 6px; border-radius: 3px; background: var(--track); overflow: hidden; }
  .mbar i { display: block; height: 100%; border-radius: 3px; background: var(--ok); }
  .mbar i.warn { background: var(--warn); } .mbar i.bad { background: var(--bad); } .mbar i.off { background: var(--faint); }
  .acct-note { font-size: 12px; color: var(--faint); }
  .acct-foot { font-size: 12px; color: var(--faint); border-top: 1px solid var(--line-soft); padding-top: 11px; }

  /* Routing */
  .rt-row { display: grid; grid-template-columns: 1.1fr 1fr 1.2fr; gap: 12px; padding: 16px 20px; font-size: 13px; align-items: start; border-bottom: 1px solid var(--line-soft); }
  .rt-row:last-child { border-bottom: none; }
  .rt-row.head { padding: 12px 20px; font-size: 12px; color: var(--faint); }
  .rt-fam { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .rt-fam b { font-weight: 500; }
  .rt-fam span { font-size: 12px; color: var(--faint); }
  .rt-to { font-size: 12.5px; overflow-wrap: anywhere; display: flex; flex-direction: column; gap: 3px; }
  .rt-to .bad-t { color: var(--bad-text); }
  .rt-note { font-family: 'Geist', ui-sans-serif, system-ui, sans-serif; font-size: 12px; color: var(--faint); }
  .rt-note.pin { color: var(--accent-text); }
  .rt-note.warn { color: var(--warn-text); }
  .rt-can { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .rt-count { display: flex; align-items: center; gap: 8px; }
  .rt-count b { color: var(--ok-text); font-weight: 500; white-space: nowrap; }
  .segs { flex: 1; display: flex; gap: 2px; max-width: 96px; }
  .segs i { flex: 1; height: 5px; border-radius: 2px; background: var(--seg-off); }
  .segs i.on { background: var(--ok); }
  .soft { color: var(--dim); }
  .dimtext { font-size: 12px; color: var(--faint); }

  /* Tables */
  .tbl-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 440px; }
  table.wide { min-width: 980px; }
  th, td { text-align: left; padding: 14px 12px; }
  th { padding-top: 12px; padding-bottom: 12px; font-size: 12px; font-weight: 400; color: var(--faint); border-bottom: 1px solid var(--line-soft); white-space: nowrap; }
  th:first-child, td:first-child { padding-left: 20px; }
  th:last-child, td:last-child { padding-right: 20px; }
  td { font-size: 13px; border-bottom: 1px solid var(--row-line); white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--hover-faint); }
  td.num, th.num { text-align: right; }
  td.dim { color: var(--faint); }
  td.soft { color: var(--dim); }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--text); }
  .ctag { display: inline-flex; align-items: center; gap: 9px; font-weight: 500; }
  .ini { width: 22px; height: 22px; border-radius: 6px; background: var(--chip); font-size: 11px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); flex: none; }
  .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--line-soft); }
  .filters label { color: var(--dim); font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .filters select { height: 28px; background: var(--field); border: 1px solid var(--line-strong); border-radius: 8px; color: var(--text); font: inherit; font-size: 12px; padding: 0 8px; }
  .hint { color: var(--faint); font-size: 12px; margin-left: auto; }

  /* Dialogs */
  .scrim { position: fixed; inset: 0; z-index: 50; background: var(--scrim); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; padding: 24px; }
  .dialog { width: 100%; max-width: 520px; max-height: calc(100vh - 48px); overflow: auto; border-radius: 16px; border: 1px solid var(--line-btn); background: var(--modal); box-shadow: var(--shadow); padding: 24px; display: flex; flex-direction: column; gap: 20px; }
  .dialog.flush { max-width: 460px; padding: 0; gap: 0; }
  .dlg-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .dlg-title { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  .steps { display: flex; flex-direction: column; gap: 18px; }
  .step { display: flex; gap: 14px; align-items: flex-start; }
  .step-n { width: 24px; height: 24px; flex: none; border-radius: 50%; background: var(--accent-soft); color: var(--accent-text); font-size: 12px; font-weight: 600; display: flex; align-items: center; justify-content: center; font-family: 'Geist Mono', ui-monospace, monospace; }
  .step-body { display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 0; }
  .step-text { font-size: 14px; line-height: 1.5; }
  .row-btns { display: flex; gap: 8px; flex-wrap: wrap; }
  .link-btn { height: 32px; padding: 0 13px; border-radius: 8px; background: var(--text); color: var(--bg); font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; }
  .link-btn:hover { color: var(--bg); text-decoration: none; opacity: .9; }
  .code-row { display: flex; gap: 8px; }
  .code-row input { flex: 1; min-width: 0; height: 32px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--field); color: var(--text); padding: 0 12px; font: 13px 'Geist Mono', ui-monospace, monospace; outline: none; }
  .code-row input:focus { border-color: var(--accent); }
  #loginNote { font-size: 12px; color: var(--dim); line-height: 1.5; }
  #loginNote.ok { color: var(--ok-text); } #loginNote.error { color: var(--bad-text); }
  .set-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 20px 22px; border-bottom: 1px solid var(--line-soft); }
  .set-id { display: flex; align-items: center; gap: 11px; min-width: 0; }
  .set-id-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .set-name { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .set-sub { font-size: 12px; color: var(--dim); }
  .set-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px 22px; }
  .set-row + .set-row { border-top: 1px solid var(--line-soft); }
  .set-text { display: flex; flex-direction: column; gap: 3px; }
  .set-text .t { font-size: 14px; font-weight: 500; }
  .set-text .d { font-size: 12px; color: var(--dim); }
  .set-note { display: none; padding: 12px 22px; font-size: 12px; color: var(--dim); border-top: 1px solid var(--line-soft); }
  .inuse { font-size: 12px; padding: 5px 9px; border-radius: 6px; background: var(--accent-soft); color: var(--accent-text); flex: none; }
  .stepper { display: flex; align-items: center; border: 1px solid var(--line-strong); border-radius: 8px; overflow: hidden; flex: none; }
  .stepper button { width: 32px; height: 32px; border: none; background: transparent; color: var(--muted); font-size: 15px; cursor: pointer; }
  .stepper button:hover { background: var(--hover-soft); color: var(--text-strong); }
  .stepper button:disabled { opacity: .5; cursor: default; }
  .stepper .val { min-width: 34px; text-align: center; font-size: 14px; border-left: 1px solid var(--line-mid); border-right: 1px solid var(--line-mid); line-height: 32px; }
  .toggle { width: 40px; height: 24px; flex: none; border-radius: 999px; border: none; padding: 3px; background: var(--toggle-off); cursor: pointer; display: flex; justify-content: flex-start; transition: background .15s; }
  .toggle.on { background: var(--accent); justify-content: flex-end; }
  .toggle:disabled { opacity: .5; cursor: default; }
  .toggle span { width: 18px; height: 18px; border-radius: 50%; background: #FFFFFF; box-shadow: 0 1px 3px rgba(0,0,0,0.4); }

  /* Key prompt and footer */
  #keybox { display: none; max-width: 400px; margin: 12vh auto 0; }
  .keycard { border-radius: 16px; border: 1px solid var(--line-btn); background: var(--modal); box-shadow: var(--shadow); padding: 28px; display: flex; flex-direction: column; gap: 16px; }
  .keycard p { color: var(--dim); font-size: 13px; }
  #key { width: 100%; height: 38px; border-radius: 9px; border: 1px solid var(--line-strong); background: var(--field); color: var(--text); padding: 0 12px; font-size: 13px; outline: none; }
  #key:focus { border-color: var(--accent); }
  footer { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--faint); }
  footer .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex: none; }

  @media (max-width: 560px) {
    .wrap { padding: 24px 16px 40px; }
    .rt-row { grid-template-columns: 1fr; gap: 6px; }
    .rt-row.head { display: none; }
    .share { grid-template-columns: 72px 1fr auto; gap: 10px; }
    .share .val { min-width: 0; }
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
      <div class="brand"><div class="logo" aria-hidden="true">TC</div><div class="title">TeamClaude</div></div>
      <p>Enter your proxy key to view status.</p>
      <input id="key" type="password" placeholder="tc-..." autocomplete="off">
      <button id="go" class="btn primary" type="button">Connect</button>
    </div>
  </div>
  <div id="app" style="display:none">
    <header class="top">
      <div class="brand">
        <div class="logo" aria-hidden="true">TC</div>
        <div class="brand-text">
          <h1 class="title">TeamClaude</h1>
          <div class="who" id="summary"></div>
        </div>
      </div>
      <div class="toolbar">
        <button id="reload" class="btn" type="button">Reload config</button>
        <button id="probe" class="btn" type="button">Probe quotas</button>
        <button id="theme" class="btn" type="button" title="Switch between following the system, light and dark"></button>
        <button id="addAcct" class="btn primary" type="button">+ Add account</button>
      </div>
    </header>

    <section class="stats" aria-label="Summary">
      <div class="stat"><div class="k" id="statActiveLabel">Active account</div><div class="v" id="statActive"></div></div>
      <div class="stat"><div class="k">Conversations</div><div class="v" id="statConv"></div></div>
      <div class="stat"><div class="k">Uptime</div><div class="v mono" id="statUp"></div></div>
      <div class="stat thr" id="thrWrap">
        <label class="k" for="thrVal">Auto-switch threshold</label>
        <div class="thr-row">
          <span class="field"><input id="thrVal" type="number" min="1" max="100" step="0.1" inputmode="decimal"><span>%</span></span>
          <button id="thrSet" class="btn sm" type="button">Set</button>
        </div>
      </div>
    </section>

    <div id="problems"></div>
    <div id="err" class="alert bad"></div>
    <div id="note"></div>

    <div class="cols" id="usageRow" style="display:none">
      <section class="sec" id="seriesWrap" style="display:none">
        <div class="sec-head"><h2 class="sec-title">Usage over time</h2></div>
        <div class="panel pad">
          <div class="chart-top">
            <div class="chart-id">
              <div class="chart-cap" id="seriesCaption"></div>
              <div class="chart-total" id="seriesTotal"></div>
            </div>
            <div class="legend" id="seriesLegend"></div>
          </div>
          <div class="bars" id="seriesBars"></div>
          <div class="ticks" id="seriesTicks"></div>
        </div>
      </section>
      <section class="sec" id="clientChartWrap" style="display:none">
        <div class="sec-head">
          <h2 class="sec-title" id="clientChartHeading">Most used</h2>
          <div class="tools">
            <span id="clientChartViewSlot"><span class="seg" id="usageViewWrap" role="group" aria-label="Usage window"></span></span>
            <span class="seg" id="clientChartMetric" role="group" aria-label="Measure"></span>
          </div>
        </div>
        <div class="panel pad">
          <div class="share-lead" id="clientChartLead"></div>
          <div class="shares" id="clientChart"></div>
          <div class="foot-note">Tokens are the uncached input and output each response reports; cached context is not counted. Traffic on the shared proxy key is not attributed to anyone.</div>
        </div>
      </section>
    </div>

    <section class="sec">
      <div class="sec-head">
        <div class="sec-title-row"><h2 class="sec-title">Accounts</h2><span class="sec-count mono" id="acctCount"></span></div>
        <div class="legend" aria-label="Meter colours">
          <span><i class="sw ok"></i>Under 60%</span>
          <span><i class="sw warn"></i>60–90%</span>
          <span><i class="sw bad"></i>Over 90%</span>
        </div>
      </div>
      <div class="acct-grid" id="accounts"></div>
    </section>

    <div class="cols" id="tablesRow" style="display:none">
      <section class="sec" id="routesWrap" style="display:none">
        <div class="sec-head"><h2 class="sec-title">Routing</h2></div>
        <div class="panel" id="routes"></div>
      </section>
      <section class="sec" id="clientsWrap" style="display:none">
        <div class="sec-head"><h2 class="sec-title" id="clientsHeading">Clients</h2></div>
        <div class="panel tbl-wrap"><table id="clients"></table></div>
      </section>
    </div>

    <div id="dimViewSlot"></div>
    <div id="dimensionsWrap" class="cols" style="display:none"></div>

    <section class="sec" id="sessionsWrap" style="display:none">
      <div class="sec-head"><h2 class="sec-title">Sessions</h2></div>
      <div class="panel">
        <div class="filters">
          <label>Project <select id="fProject"></select></label>
          <label>Client <select id="fClient"></select></label>
          <span class="hint" id="sessionCount"></span>
        </div>
        <div class="tbl-wrap"><table id="sessions" class="wide"></table></div>
      </div>
    </section>

    <footer><span class="dot"></span><span id="foot"></span></footer>
  </div>

  <div id="loginWrap" class="scrim" style="display:none">
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="loginTitle">
      <div class="dlg-head">
        <div class="dlg-title" id="loginTitle">Add a Claude account</div>
        <button id="loginClose" class="btn ghost" type="button">Close</button>
      </div>
      <div class="steps">
        <div class="step">
          <div class="step-n">1</div>
          <div class="step-body">
            <div class="step-text">Open the sign-in link and sign in as the account you want to add.</div>
            <div class="row-btns">
              <a id="loginLink" class="link-btn" target="_blank" rel="noopener noreferrer">Open sign-in link ↗</a>
              <button id="loginCopy" class="btn outline" type="button">Copy link</button>
            </div>
          </div>
        </div>
        <div class="step">
          <div class="step-n">2</div>
          <div class="step-body">
            <div class="step-text">Claude shows a code. Paste it here.</div>
            <div class="code-row">
              <input id="loginCode" type="text" placeholder="Code from the sign-in page" autocomplete="off" spellcheck="false">
              <button id="loginGo" class="btn go" type="button">Add account</button>
            </div>
          </div>
        </div>
      </div>
      <div id="loginNote"></div>
    </section>
  </div>

  <div id="settingsWrap" class="scrim" style="display:none">
    <section class="dialog flush" id="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="setName"></section>
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
  // The usage window applies to every view the usage trackers feed (the two
  // charts, Clients and each configured dimension), so it is page state rather
  // than per-table: two controls left on different windows would invite reading
  // one number against the other. Like the sort, it survives the poll.
  var usageView = 'total';
  var usageButtons = [];
  // The measure both charts plot, page state like the window above.
  var CHART_METRICS = [{ key: 'tokens', label: 'Tokens' }, { key: 'requests', label: 'Requests' }];
  var chartMetric = 'tokens';
  var chartButtons = [];
  // The usage-over-time series, fetched on its own (GET /teamclaude/usage/
  // series) after each status poll that shows a client. One fetch at a time:
  // a slow answer is not stacked behind by the next poll's.
  var lastSeries = null;
  var seriesError = null;
  var seriesInFlight = false;
  // How the summary line names a signed-in client key's role.
  var VIEWER_ROLE_TEXT = { operator: 'admin', tenant: 'user', readonly: 'read-only' };
  // Add account: the state naming the sign-in link now open, or null. The
  // server holds everything else about that login; the link is only opened.
  var loginState = null;
  // The account whose settings dialog is open, by name, and what its rows were
  // last built from: the poll rebuilds the dialog only when that changes, so a
  // focused control is not pulled out from under the keyboard every 5s.
  var settingsFor = null;
  var settingsBuiltFrom = '';
  var settingsNote = null;
  var AVATAR_HUES = [45, 250, 150, 300, 80, 190, 20, 120];
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var GEAR_PATH = ${JSON.stringify(GEAR_PATH)};
  var UNAVAILABLE_TEXT = ${JSON.stringify(UNAVAILABLE_TEXT)};

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

  function metricText(v) {
    return fmtNum(v) + (chartMetric === 'requests' ? ' req' : ' tok');
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

  function avatar(name, index, cls) {
    var av = el('div', 'avatar' + (cls ? ' ' + cls : ''), initialOf(name));
    av.setAttribute('aria-hidden', 'true');
    av.style.cssText = '--h: ' + AVATAR_HUES[index % AVATAR_HUES.length];
    return av;
  }

  function gearIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    [['width', '15'], ['height', '15'], ['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'],
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

  // One labelled meter: the figure set bright, what it is measured against
  // dim after it, and a bar coloured by meterTone unless a tone is given.
  function meter(label, ratio, figure, meta, tone, title) {
    var m = el('div', 'meter');
    if (title) m.title = title;
    var top = el('div', 'meter-top');
    top.appendChild(el('span', 'lbl', label));
    var v = el('span', 'mv');
    v.appendChild(el('b', '', figure));
    if (meta) v.appendChild(el('span', '', meta));
    top.appendChild(v);
    m.appendChild(top);
    var bar = el('div', 'mbar');
    var fill = el('i', tone || meterTone(ratio));
    var pct = ratio == null ? 0 : Math.max(0, Math.min(1, Number(ratio)));
    fill.style.width = (pct * 100) + '%';
    bar.appendChild(fill);
    m.appendChild(bar);
    return m;
  }

  function quotaMeter(label, ratio, resetAt) {
    var pct = ratio == null ? null : Math.max(0, Math.min(1, Number(ratio)));
    var resetTs = parseTs(resetAt);
    var reset = !isNaN(resetTs) && resetTs > Date.now()
      ? ' · ' + fmtIn((resetTs - Date.now()) / 1000) + ' · ' + fmtClock(resetTs)
      : '';
    return meter(label, ratio, pct == null ? '?' : Math.round(pct * 100) + '%', reset);
  }

  function renderAccount(a, index, s) {
    var viewer = s.viewer || null;
    var isCur = isCurrentAccount(a, s);
    var card = el('div', 'acct' + (isCur ? ' current' : '') + (a.disabled ? ' off' : ''));
    var head = el('div', 'acct-head');
    var id = el('div', 'acct-id');
    var nameRow = el('div', 'acct-name-row');
    nameRow.appendChild(avatar(a.name, index, ''));
    var name = el('div', 'acct-name', a.name);
    name.title = a.name;
    nameRow.appendChild(name);
    id.appendChild(nameRow);
    var chips = el('div', 'chips');
    accountBadges(a, s.currentAccount, s.currentAccounts || null, null, s.switchThreshold, s.switchThresholds).forEach(function (badge) {
      chips.appendChild(el('span', 'chip ' + badge.cls, badge.text));
    });
    id.appendChild(chips);
    head.appendChild(id);
    // Every control for the account lives in its settings dialog, offered to
    // whoever may use at least one of them (a tenant may switch, no more).
    if (viewerCan(viewer, 'switch') || viewerCan(viewer, 'accounts')) {
      var gear = el('button', 'gear');
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
      card.appendChild(el('div', 'blocked' + (a.unavailable === 'error' ? ' bad' : ''),
        'Blocked — ' + (UNAVAILABLE_TEXT[a.unavailable] || a.unavailable)));
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
    card.appendChild(el('div', 'acct-foot', (u.totalRequests || 0) + ' req · ' + fmtNum(accountTokens(u)) + ' tok' + last));
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
    var close = el('button', 'btn ghost', 'Close');
    close.type = 'button';
    close.addEventListener('click', closeSettings);
    head.appendChild(close);
    d.appendChild(head);

    if (viewerCan(viewer, 'switch')) {
      var cur = settingsRow('Current account', isCur ? 'New requests go to this account'
        : a.disabled ? 'Enable the account to switch to it' : 'Route new requests here');
      if (isCur) cur.appendChild(el('span', 'inuse', 'In use'));
      else if (!a.disabled) {
        var sw = el('button', 'btn go', 'Switch to this');
        sw.type = 'button';
        sw.addEventListener('click', function () { doSwitch(a.name, sw); });
        cur.appendChild(sw);
      }
      d.appendChild(cur);
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
      d.appendChild(pr);

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
      d.appendChild(en);
    }
    var n = el('div', 'set-note');
    n.id = 'setNote';
    if (settingsNote) {
      n.className = 'set-note ' + settingsNote.kind;
      n.textContent = settingsNote.text;
      n.style.display = 'block';
    }
    d.appendChild(n);
  }

  // ── Charts ───────────────────────────────────────────────────────────────

  // The window and measure buttons, built once: the windows are fixed by the
  // server that served this page.
  function buildControls() {
    var views = byId('usageViewWrap');
    USAGE_VIEWS.forEach(function (v) {
      var btn = el('button', '', v.label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        usageView = v.key;
        markSelected(usageButtons, usageView);
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
  }

  function markSelected(buttons, key) {
    buttons.forEach(function (b) {
      b.btn.className = b.key === key ? 'sel' : '';
      b.btn.setAttribute('aria-pressed', b.key === key ? 'true' : 'false');
    });
  }

  // One bar per client, longest first, the biggest in the accent colour.
  function renderClientChart(clients) {
    var wrap = byId('clientChartWrap');
    var rows = clientRanking(clients, usageView, chartMetric);
    if (!rows.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    byId('clientChartLead').textContent = 'Share of ' + (chartMetric === 'requests' ? 'requests' : 'tokens') + ' by client key';
    var box = byId('clientChart');
    box.textContent = '';
    rows.forEach(function (r, i) {
      var row = el('div', 'share');
      var n = el('div', 'n', r.name);
      n.title = r.name;
      row.appendChild(n);
      var track = el('div', 'track');
      var bar = el('i', i === 0 ? 'top' : '');
      // Anything spent draws at least 2px: a bar of nothing would read as the
      // zero it is not.
      bar.style.width = r.value > 0 ? 'max(2px, ' + (r.ratio * 100).toFixed(2) + '%)' : '0';
      track.appendChild(bar);
      row.appendChild(track);
      var val = el('div', 'val');
      val.appendChild(el('b', '', metricText(r.value)));
      val.appendChild(el('span', '', ' · ' + fmtShare(r.share)));
      row.appendChild(val);
      box.appendChild(row);
    });
  }

  // Usage over time, drawn from the last series fetched. Total has no series
  // of its own — the tracker keeps a day of history, not a lifetime — so it
  // shows the day, and the caption says which span is on screen.
  function renderSeries() {
    var wrap = byId('seriesWrap');
    if (!lastStatus || !Object.keys(lastStatus.clients || {}).length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var chart = seriesBars(lastSeries, usageView, chartMetric);
    var spanMs = chart.spanMs || (usageView === '5h' ? 5 : 24) * 3600000;
    var hours = Math.round(spanMs / 3600000) + 'h';
    byId('seriesCaption').textContent = (chartMetric === 'requests' ? 'Requests' : 'Tokens') + ' · last ' + hours + ', hourly';
    byId('seriesTotal').textContent = lastSeries ? metricText(chart.total) : '—';
    var legend = byId('seriesLegend');
    legend.textContent = '';
    var names = chart.legend.slice();
    if (chart.hasOthers) names.push(null);
    names.forEach(function (name, i) {
      var item = el('span');
      item.appendChild(el('i', 'sw ' + (name == null ? 'so' : 's' + i)));
      item.appendChild(el('span', '', name == null ? 'others' : name));
      legend.appendChild(item);
    });
    var box = byId('seriesBars');
    box.textContent = '';
    if (!lastSeries || !chart.total) {
      box.appendChild(el('div', 'bars-empty', !lastSeries
        ? (seriesError ? 'Usage history unavailable: ' + seriesError : 'Loading usage history…')
        : 'No client-key traffic in the last ' + hours));
    } else {
      chart.bars.forEach(function (b) {
        var col = el('div', 'col');
        var lines = [fmtHM(b.start) + '–' + fmtHM(b.end) + ' · ' + metricText(b.total)];
        chart.legend.forEach(function (name, i) { if (b.parts[i]) lines.push(name + ': ' + metricText(b.parts[i])); });
        if (b.others) lines.push('others: ' + metricText(b.others));
        col.title = lines.join('\\n');
        // Top to bottom: others, then the legend in reverse, so the biggest
        // client sits on the baseline of every bar.
        var segs = [{ v: b.others, cls: 'so' }];
        for (var i = b.parts.length - 1; i >= 0; i--) segs.push({ v: b.parts[i], cls: 's' + i });
        segs.forEach(function (seg) {
          if (!seg.v) return;
          var part = el('i', seg.cls);
          part.style.height = 'max(1px, ' + (seg.v / chart.peak * 100).toFixed(2) + '%)';
          col.appendChild(part);
        });
        box.appendChild(col);
      });
    }
    var ticks = byId('seriesTicks');
    ticks.textContent = '';
    seriesTicks(spanMs).forEach(function (t) { ticks.appendChild(el('span', '', t)); });
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
      .then(function () { seriesInFlight = false; renderSeries(); });
  }

  // ── Tables ───────────────────────────────────────────────────────────────

  // Last used is a lifetime figure in a table whose heading may name a window.
  // Under Total that needs no saying; under a window it does, or it reads as
  // the one thing this control must never do — a number under the wrong label.
  function lastUsedLabel() {
    return usageView === 'total' ? 'Last used' : 'Last used (all time)';
  }

  // The window a usage table is showing, in its own heading: the control sits
  // with the charts, and the tables below can be scrolled clear of it.
  function usageHeading(base) {
    if (usageView === 'total') return base;
    var view = USAGE_VIEWS.filter(function (v) { return v.key === usageView; })[0];
    return view ? base + ' · ' + view.label.toLowerCase() : base;
  }

  function renderClients(clients) {
    var wrap = byId('clientsWrap');
    var names = Object.keys(clients || {});
    if (!names.length) { wrap.style.display = 'none'; return false; }
    wrap.style.display = '';
    byId('clientsHeading').textContent = usageHeading('Clients');
    // Sorted on the window being shown, not on the lifetime total: a table
    // ordered by all-time spend while displaying the last five hours would put
    // the quiet clients on top of the busy one.
    names.sort(function (a, b) {
      var ua = usageFor(clients[a], usageView), ub = usageFor(clients[b], usageView);
      return (ub.inputTokens + ub.outputTokens) - (ua.inputTokens + ua.outputTokens);
    });
    var table = byId('clients');
    table.textContent = '';
    var hr = el('tr');
    ['Client', 'Requests', 'WebSockets', 'Input tok', 'Output tok', lastUsedLabel()].forEach(function (h, i) {
      hr.appendChild(el('th', i ? 'num' : '', h));
    });
    table.appendChild(hr);
    names.forEach(function (n) {
      var c = clients[n];
      var u = usageFor(c, usageView);
      var tr = el('tr');
      var cell = el('td');
      var tag = el('span', 'ctag');
      tag.appendChild(el('span', 'ini', initialOf(n)));
      tag.appendChild(el('span', '', n));
      cell.appendChild(tag);
      tr.appendChild(cell);
      tr.appendChild(el('td', 'num', fmtNum(u.requests)));
      tr.appendChild(el('td', 'num dim', fmtNum(u.connections)));
      tr.appendChild(el('td', 'num', fmtNum(u.inputTokens)));
      tr.appendChild(el('td', 'num', fmtNum(u.outputTokens)));
      // Last used stays the lifetime figure under every window: it answers
      // when this client was last seen at all, which a window cannot.
      tr.appendChild(el('td', 'num soft', c.lastUsed ? fmtAgo(c.lastUsed) : '—'));
      table.appendChild(tr);
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
    // summary strip stay either way.
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

      var sec = el('section', 'sec');
      var head = el('div', 'sec-head');
      head.appendChild(el('h2', 'sec-title', usageHeading(title)));
      sec.appendChild(head);
      var panel = el('div', 'panel tbl-wrap');
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
      panel.appendChild(table);
      sec.appendChild(panel);
      wrap.appendChild(sec);
    });
    wrap.style.display = any ? '' : 'none';
    return any;
  }

  // Where each metered family goes right now, and which accounts could take
  // it. The last rows are the per-provider defaults: everything without a
  // route of its own lands on the current account.
  function renderRoutes(s) {
    var wrap = byId('routesWrap');
    var rows = routeRows(s);
    if (!rows.length) { wrap.style.display = 'none'; return false; }
    wrap.style.display = '';
    var box = byId('routes');
    box.textContent = '';
    var hr = el('div', 'rt-row head');
    ['Family', 'Goes to', 'Can serve it'].forEach(function (h) { hr.appendChild(el('div', '', h)); });
    box.appendChild(hr);
    rows.forEach(function (r) {
      var row = el('div', 'rt-row');
      var fam = el('div', 'rt-fam');
      fam.appendChild(el('b', '', r.label));
      var sub = [r.match, r.provider ? providerLabel(r.provider) : ''].filter(Boolean).join(' · ');
      if (sub) fam.appendChild(el('span', '', sub));
      row.appendChild(fam);

      var to = el('div', 'rt-to');
      to.appendChild(el('span', r.blocked ? 'bad-t' : '', r.blocked ? 'blocked' : (r.target || '—')));
      if (r.pinned) to.appendChild(el('span', 'rt-note pin', 'pinned to ' + r.pinned + (r.pinMismatch ? ' (not eligible)' : '')));
      if (r.kind === 'default' && r.target !== r.current) {
        to.appendChild(el('span', 'rt-note warn', r.currentUnavailable
          ? 'current account ' + r.current + ' is blocked: ' + (UNAVAILABLE_TEXT[r.currentUnavailable] || r.currentUnavailable)
          : 'outranks the current account ' + r.current));
      }
      row.appendChild(to);

      var can = el('div', 'rt-can');
      var total = r.eligible.length + r.ineligible.length;
      if (r.kind === 'default') can.appendChild(el('span', 'soft', 'No route of its own'));
      else if (r.blocked || !total) can.appendChild(el('span', 'soft', '—'));
      else {
        var count = el('div', 'rt-count');
        count.appendChild(el('b', '', r.eligible.length + ' of ' + total));
        var segs = el('div', 'segs');
        segs.setAttribute('aria-hidden', 'true');
        for (var i = 0; i < total; i++) segs.appendChild(el('i', i < r.eligible.length ? 'on' : ''));
        count.appendChild(segs);
        can.appendChild(count);
        if (r.ineligible.length) {
          var un = el('div', 'dimtext', 'Unavailable: ' + r.ineligible.map(shortName).join(', '));
          un.title = r.ineligible.join(', ');
          can.appendChild(un);
        }
      }
      row.appendChild(can);
      box.appendChild(row);
    });
    return true;
  }

  // Top of the page and only when something is wrong: a banner that is always
  // on is a banner nobody reads.
  function renderProblems(s) {
    var wrap = byId('problems');
    var list = problems(s);
    wrap.textContent = '';
    if (!list.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    list.forEach(function (p) { wrap.appendChild(el('div', 'alert ' + p.severity, p.text)); });
  }

  // ── Header and summary strip ─────────────────────────────────────────────

  function renderHeader(s) {
    var viewer = s.viewer || null;
    var sum = byId('summary');
    sum.textContent = '';
    // Who this page is signed in as: the controls below appear or not by that,
    // and a missing button should not be a puzzle.
    if (viewer && viewer.client) {
      var who = el('span', '', 'Signed in as ');
      who.appendChild(el('b', '', viewer.client));
      sum.appendChild(who);
      sum.appendChild(el('span', 'pill', VIEWER_ROLE_TEXT[viewer.role] || viewer.role));
    } else if (viewer) {
      sum.appendChild(el('span', '', 'Operator access'));
      sum.appendChild(el('span', 'pill', VIEWER_ROLE_TEXT[viewer.role] || viewer.role));
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
    probeBtn.textContent = probe.running ? 'Probe running…' : 'Probe quotas';
    probeBtn.disabled = !!probe.running;
  }

  function renderStats(s) {
    var currentAccounts = s.currentAccounts || null;
    var providers = currentAccounts ? Object.keys(currentAccounts).sort(function (a, b) {
      if (a === 'anthropic') return -1;
      if (b === 'anthropic') return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    }) : [];
    var act = byId('statActive');
    act.textContent = '';
    var line = function (name, prefix) {
      var l = el('span', 'line');
      l.appendChild(el('span', name ? 'live' : 'live none'));
      if (prefix) l.appendChild(el('span', 'sub', prefix));
      var n = el('span', 'ellip', name || 'none');
      if (name) n.title = name;
      l.appendChild(n);
      return l;
    };
    // One cursor per provider: a mixed Claude/Codex fleet has two current
    // accounts, and naming one of them "the" active account would be wrong.
    if (providers.length > 1) {
      byId('statActiveLabel').textContent = 'Active accounts';
      act.className = 'v stack';
      providers.forEach(function (p) { act.appendChild(line(currentAccounts[p], providerLabel(p))); });
    } else {
      byId('statActiveLabel').textContent = 'Active account';
      act.className = 'v';
      act.appendChild(line(providers.length ? currentAccounts[providers[0]] : s.currentAccount, ''));
    }
    // Conversations, like the table below and the count above that table: one
    // page saying "sessions" here and "conversations" there would read as two
    // different quantities rather than one counted twice.
    var sess = s.sessions || {};
    var conv = byId('statConv');
    conv.textContent = '';
    conv.appendChild(el('span', 'mono', String(sess.active || 0)));
    conv.appendChild(el('span', 'sub', 'active ·'));
    conv.appendChild(el('span', 'mono', String(sess.known || 0)));
    conv.appendChild(el('span', 'sub', 'known'));
    byId('statUp').textContent = s.server && s.server.uptimeSeconds != null ? fmtIn(s.server.uptimeSeconds) : '—';
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
    renderStats(s);
    var accounts = s.accounts || [];
    var enabled = accounts.filter(function (a) { return !a.disabled; }).length;
    byId('acctCount').textContent = accounts.length ? enabled + ' of ' + accounts.length + ' enabled' : '';
    var acc = byId('accounts');
    acc.textContent = '';
    accounts.forEach(function (a, i) { acc.appendChild(renderAccount(a, i, s)); });
    renderProblems(s);
    var hasClients = Object.keys(s.clients || {}).length > 0;
    renderClientChart(s.clients);
    renderSeries();
    byId('usageRow').style.display = hasClients ? '' : 'none';
    var hasRoutes = renderRoutes(s);
    var hasClientTable = renderClients(s.clients);
    byId('tablesRow').style.display = hasRoutes || hasClientTable ? '' : 'none';
    var hasDims = renderDimensions(s.usageDimensions);
    // The window control sits with the charts. A fleet with dimensions but no
    // client keys has no charts, and gets the control above its tables
    // instead, since those tables are what it governs there.
    var views = byId('usageViewWrap');
    var dimSlot = byId('dimViewSlot');
    (hasClients ? byId('clientChartViewSlot') : dimSlot).appendChild(views);
    dimSlot.style.display = !hasClients && hasDims ? 'flex' : 'none';
    renderSessions(s.sessions);
    if (settingsFor) renderSettings();
    var foot = byId('foot');
    foot.textContent = 'Refreshes every ' + (POLL_MS / 1000) + 's · last update ';
    foot.appendChild(el('span', 'mono', new Date().toLocaleTimeString()));
  }

  // ── Controls ─────────────────────────────────────────────────────────────

  function note(kind, text) {
    var n = byId('note');
    n.className = kind;
    n.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · ' + text;
    n.style.display = 'block';
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
        byId('app').style.display = '';
        byId('err').style.display = 'none';
        render(s);
        // The chart's history is only worth asking for when there is a client
        // to chart; the Clients table is what says so.
        if (Object.keys(s.clients || {}).length) pollSeries();
      })
      .catch(function (e) {
        var err = byId('err');
        err.style.display = 'flex';
        err.textContent = 'Cannot reach the proxy: ' + e.message;
        // The banner lives inside #app, which stays hidden until a first
        // status lands; without this a first poll that fails is a blank page.
        if (byId('keybox').style.display !== 'block') byId('app').style.display = '';
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
    // Name the state, not the action: a button reading "Dark" while the page is
    // light is the ambiguity every theme toggle has, and this one says where it
    // is rather than where it would go.
    byId('theme').textContent = theme === 'system' ? 'Theme: system' : theme === 'light' ? 'Theme: light' : 'Theme: dark';
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

  byId('reload').addEventListener('click', function () { doControl('/teamclaude/reload', 'config reload', this); });
  byId('probe').addEventListener('click', function () { doControl('/teamclaude/probe', 'quota probe', this); });
  byId('thrSet').addEventListener('click', function () { doThreshold(this); });
  byId('thrVal').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') byId('thrSet').click();
  });
  buildControls();
  byId('addAcct').addEventListener('click', function () { doLoginStart(this); });
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
