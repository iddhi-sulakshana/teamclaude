import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  renderDashboardHtml, dashboardCsp, inlineScripts, scopedWeeklyRows, accountTokens, accountTokenSplit,
  accountBadges, thresholdBadgeText, extraUsageText, extraUsageBar, meterTone, clientGroups, seriesLines, userLineNames, userSlots, smoothPath, heatGrid, seriesTicks,
  sessionRows, filterSessionRows, sortRows, uniqSorted, accountDisplayOrder,
  switchRequest, switchOutcome, accountControlRequest, accountControlOutcome, routeRows, problems, STARVED_MIN, STARVED_LIST_MAX,
  thresholdRequest, thresholdPercentText, thresholdOutcome,
  usageFor, USAGE_VIEWS, clientRanking, viewerCan, loginStartRequest, loginFinishRequest, loginOutcome, userRequest, userOutcome, rotateKeyRequest,
} from '../src/dashboard.js';
import { USAGE_WINDOWS } from '../src/client-usage.js';
import { normalizeSpend } from '../src/oauth.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// The page's pure logic is exported and serialized into the script, so these
// exercise the same functions the browser runs.

test('scopedWeekly names the buckets, not a hard-coded pair', () => {
  const rows = scopedWeeklyRows({
    scopedWeekly: {
      sonnet: { utilization: 0.5, resetAt: 100 },
      opus: { utilization: 0.1, resetAt: 200 },
    },
  });
  // A family upstream started metering must appear without a release.
  assert.deepEqual(rows.map(r => r.family), ['opus', 'sonnet']);
  assert.deepEqual(rows[1], { family: 'sonnet', label: 'Sonnet', utilization: 0.5, resetAt: 100 });
});

test('scopedWeekly falls back to the dedicated fields, and never doubles a family', () => {
  // A usage payload with `seven_day_sonnet` but no `limits` array leaves
  // scopedWeekly empty while the dedicated field is set — the bar must still show.
  assert.deepEqual(
    scopedWeeklyRows({ unified7dSonnet: 0.3, unified7dSonnetReset: 9 }),
    [{ family: 'sonnet', label: 'Sonnet', utilization: 0.3, resetAt: 9 }],
  );
  const both = scopedWeeklyRows({
    scopedWeekly: { sonnet: { utilization: 0.5, resetAt: 100 } },
    unified7dSonnet: 0.3,
    unified7dSonnetReset: 9,
  });
  assert.equal(both.length, 1);
  assert.equal(both[0].utilization, 0.5);
  assert.deepEqual(scopedWeeklyRows({}), []);
  assert.deepEqual(scopedWeeklyRows(null), []);
});

test('account token split puts the cache on the input side', () => {
  assert.deepEqual(accountTokenSplit({
    totalInputTokens: 1, totalOutputTokens: 2,
    totalCacheReadTokens: 100, totalCacheCreationTokens: 10,
  }), { input: 111, output: 2 });
  assert.deepEqual(accountTokenSplit(null), { input: 0, output: 0 });
});

test('account token total includes the cache fields', () => {
  // totalInputTokens counts uncached input only; omitting the cache fields
  // understates a Claude Code account by orders of magnitude.
  assert.equal(accountTokens({
    totalInputTokens: 1, totalOutputTokens: 2,
    totalCacheReadTokens: 100, totalCacheCreationTokens: 10,
  }), 113);
  assert.equal(accountTokens({}), 0);
  assert.equal(accountTokens(null), 0);
});

test('account metadata and session state are separate badges', () => {
  const badges = accountBadges({
    name: 'corp', provider: 'codex', type: 'oauth', priority: -2,
    status: 'active', sessions: 1, knownSessions: 3,
  }, 'legacy', { anthropic: 'personal', codex: 'corp' });
  assert.deepEqual(badges, [
    { cls: 'current', text: 'current' },
    { cls: 'meta priority', text: 'prio -2' },
    { cls: 'provider codex', text: 'Codex' },
    { cls: 'sessions', text: '1 recent' },
    { cls: 'sessions known', text: '3 known' },
  ]);
});

test('accountBadges leaves out what every account in a Claude OAuth fleet would repeat', () => {
  // Claude, oauth and active are the common case: a badge each on every card
  // is noise that buries the ones that differ.
  assert.deepEqual(accountBadges({ name: 'a', provider: 'anthropic', type: 'oauth', status: 'active' }, 'b'),
    [{ cls: 'meta priority', text: 'prio 0' }]);
  // Anything off the common case still says so.
  const odd = accountBadges({ name: 'a', provider: 'anthropic', type: 'api_key', status: 'throttled' }, 'b');
  assert.deepEqual(odd.map(b => b.text), ['prio 0', 'throttled', 'api_key']);
  assert.deepEqual(accountBadges({ name: 'a', disabled: true, status: 'active' }, 'b').map(b => b.text), ['prio 0', 'disabled']);
});

// ── per-account switch threshold (#409) ───────────────────────

test('thresholdBadgeText is silent with no override, or one that matches the fleet', () => {
  assert.equal(thresholdBadgeText(null, 0.98, null), '');
  assert.equal(thresholdBadgeText(undefined, 0.98, null), '');
  assert.equal(thresholdBadgeText(0.98, 0.98, null), '');
  assert.equal(thresholdBadgeText({ unified7d: 0.98 }, 0.98, null), '');
  // A hand-edited array is the #425 hazard class — refused, not spread into
  // numeric bucket keys.
  assert.equal(thresholdBadgeText([0.5], 0.98, null), '');
});

test('thresholdBadgeText names a bare-number override "at", and a table by bucket', () => {
  assert.equal(thresholdBadgeText(1.0, 0.98, null), 'switch at 100%');
  assert.equal(thresholdBadgeText({ unified7dFable: 0.8 }, 0.98, null), 'switch fable 80%');
  assert.equal(
    thresholdBadgeText({ unified7d: 0.9, unified7dFable: 0.8 }, 0.98, null),
    'switch 7d 90%, fable 80%',
  );
  // A per-bucket fleet table, not just a bare fleet number: the account's
  // unified7d entry is compared against the fleet's OWN unified7d, not its
  // default — an account that merely matches the fleet's per-bucket override
  // must stay silent on that bucket.
  assert.equal(thresholdBadgeText({ unified7d: 0.9 }, 0.98, { default: 0.98, unified7d: 0.9 }), '');
  assert.equal(thresholdBadgeText({ unified7d: 0.85 }, 0.98, { default: 0.98, unified7d: 0.9 }), 'switch 7d 85%');
});

test('thresholdBadgeText names a bucket the account default moves off the fleet table', () => {
  // The defaults agree, so the old default-to-default comparison said nothing,
  // yet this account's weekly wall really is 98% where the fleet's is 85%.
  const fleetTable = { default: 0.98, unified7d: 0.85 };
  assert.equal(thresholdBadgeText(0.98, 0.98, fleetTable), 'switch 7d 98%');
  assert.equal(thresholdBadgeText({ default: 0.98 }, 0.98, fleetTable), 'switch 7d 98%');
  // An account entry for that bucket answers for it, equal to the fleet's or not.
  assert.equal(thresholdBadgeText({ default: 0.98, unified7d: 0.85 }, 0.98, fleetTable), '');
  // A differing default already covers every unlisted bucket.
  assert.equal(thresholdBadgeText(1.0, 0.98, fleetTable), 'switch at 100%');
});

test('accountBadges names a routed account\'s proxy as the status payload masks it, and stays silent otherwise', () => {
  const routed = accountBadges({ name: 'a', type: 'oauth', routing: 'socks5h://alice:***@proxy.example.com:1080' }, null, null);
  assert.deepEqual(routed.find(b => b.cls === 'meta routing'), { cls: 'meta routing', text: 'via socks5h://alice:***@proxy.example.com:1080' });
  assert.equal(accountBadges({ name: 'a', type: 'oauth' }, null, null).some(b => /routing/.test(b.cls)), false);
  // The payload is masked at the source. A parsed object would mean the live
  // account leaked into it, password and all: draw nothing rather than that.
  const leaked = accountBadges({ name: 'a', type: 'oauth', routing: { host: 'h', password: 'p' } }, null, null);
  assert.equal(leaked.some(b => /routing/.test(b.cls)), false);
});

test('accountBadges adds the threshold badge only when it differs from the fleet', () => {
  const withFleet = accountBadges({ name: 'a', type: 'oauth', switchThreshold: 1.0 }, null, null, null, 0.98, null);
  assert.deepEqual(withFleet[withFleet.length - 1], { cls: 'meta threshold', text: 'switch at 100%' });

  const matching = accountBadges({ name: 'a', type: 'oauth', switchThreshold: 0.98 }, null, null, null, 0.98, null);
  assert.ok(!matching.some(b => b.cls.includes('threshold')), 'an override equal to the fleet stays silent');

  // No `switchThreshold` on the account at all (the common case, and the
  // shape the pre-#409 unit test above still exercises): no badge, whatever
  // the fleet args are, fleet omitted included — never a crash.
  const noOverride = accountBadges({ name: 'a', type: 'oauth' }, null, null);
  assert.ok(!noOverride.some(b => b.cls.includes('threshold')));
});

// The shape the server emits: a row is one CONVERSATION, keyed by the pin key
// routing uses, with the session it belongs to and the conversation's digest
// beside it as separate labels.
const SESSIONS = {
  items: [
    {
      id: 's-old/conv-old-0123456789abc', session: 's-old', conversation: 'conv-old-0123456789abc',
      client: 'bob', dimensions: { project: 'p2' }, active: false,
      requests: 2, lastSeen: 200, pins: { unified7d: 1 },
      tokens: { unified7d: { cacheRead: 5, cacheCreation: 1, input: 2, output: 1, context: 8 } },
    },
    {
      id: 's-new/conv-new-0123456789abc', session: 's-new', conversation: 'conv-new-0123456789abc',
      client: 'alice', dimensions: { project: 'p1' }, active: true,
      requests: 1, lastSeen: 100, pins: { unified7d: 0, unified7dFable: 1 },
      tokens: {
        unified7d: { cacheRead: 900, cacheCreation: 50, input: 10, output: 5, context: 960 },
        unified7dFable: { cacheRead: 0, cacheCreation: 0, input: 4, output: 2, context: 4 },
      },
    },
  ],
};

test('a conversation row totals what the responses reported, cache included', () => {
  const rows = sessionRows(SESSIONS);
  const row = rows.find(r => r.session === 's-new');
  // input+output alone would say 21 for a conversation that actually cost 971.
  assert.equal(row.input + row.output, 21);
  assert.equal(row.total, 971);
  assert.equal(row.cacheRead, 900);
  // Summed across every weekly bucket the conversation touched.
  assert.equal(row.context, 964);
  // A conversation spending two model families is served by two accounts at
  // once, which is why this is a pin map and not one index.
  assert.equal(row.accounts, '0, 1');
  assert.equal(row.client, 'alice');
  assert.equal(row.project, 'p1');
});

test('a fan-out is one row per conversation, under the one session that owns them', () => {
  // The rows of one client session are identical but for the conversation, so
  // the session alone cannot tell them apart — and the key that can is a
  // composite nobody recognises, so it is not what the table shows.
  const rows = sessionRows({
    items: [
      { id: 'sess-7/aaaaaaaaaaaaaaaaaaaaaa', session: 'sess-7', conversation: 'aaaaaaaaaaaaaaaaaaaaaa', client: 'alice', pins: {}, tokens: {} },
      { id: 'sess-7/bbbbbbbbbbbbbbbbbbbbbb', session: 'sess-7', conversation: 'bbbbbbbbbbbbbbbbbbbbbb', client: 'alice', pins: {}, tokens: {} },
    ],
  });
  assert.deepEqual(rows.map(r => r.session), ['sess-7', 'sess-7']);
  // Eight characters of the digest: enough to separate siblings, narrow enough
  // for a column beside the session.
  assert.deepEqual(rows.map(r => r.conversation), ['aaaaaaaa', 'bbbbbbbb']);
});

test('session rows tolerate a payload with nothing in it', () => {
  assert.deepEqual(sessionRows({}), []);
  assert.deepEqual(sessionRows(null), []);
  // A record no request ever labelled (touch() alone) names no session, and
  // falls back to the key it is filed under rather than rendering blank.
  const [bare] = sessionRows({ items: [{ id: 'x' }] });
  assert.deepEqual(
    { id: bare.id, session: bare.session, conversation: bare.conversation, client: bare.client, project: bare.project, total: bare.total, accounts: bare.accounts },
    { id: 'x', session: 'x', conversation: '', client: '', project: '', total: 0, accounts: '' },
  );
});

test('filters narrow by project and client, and combine', () => {
  const rows = sessionRows(SESSIONS);
  assert.deepEqual(filterSessionRows(rows, { project: 'p1' }).map(r => r.session), ['s-new']);
  assert.deepEqual(filterSessionRows(rows, { client: 'bob' }).map(r => r.session), ['s-old']);
  assert.deepEqual(filterSessionRows(rows, { project: 'p1', client: 'bob' }), []);
  // An empty filter is "All", not a match against the empty string.
  assert.equal(filterSessionRows(rows, { project: '', client: '' }).length, 2);
  assert.equal(filterSessionRows(rows, {}).length, 2);
});

test('sorting handles both text and number columns, and does not mutate', () => {
  const rows = sessionRows(SESSIONS);
  const before = rows.map(r => r.session);
  assert.deepEqual(sortRows(rows, 'total', 'desc').map(r => r.session), ['s-new', 's-old']);
  assert.deepEqual(sortRows(rows, 'total', 'asc').map(r => r.session), ['s-old', 's-new']);
  assert.deepEqual(sortRows(rows, 'client', 'asc').map(r => r.session), ['s-new', 's-old']);
  assert.deepEqual(sortRows(rows, 'client', 'desc').map(r => r.session), ['s-old', 's-new']);
  assert.deepEqual(rows.map(r => r.session), before, 'the caller\'s array is untouched');
  assert.deepEqual(sortRows(null, 'total', 'desc'), []);
});

test('blocked and disabled accounts sort after the serving ones, each group in fleet order', () => {
  const accounts = [
    { name: 'a', unavailable: 'throttled' },
    { name: 'b' },
    { name: 'c', disabled: true, unavailable: 'disabled' },
    { name: 'd' },
    { name: 'e', unavailable: 'quota' },
  ];
  assert.deepEqual(accountDisplayOrder(accounts), [1, 3, 0, 2, 4]);
  assert.deepEqual(accountDisplayOrder([{ name: 'x' }, { name: 'y' }]), [0, 1]);
  assert.deepEqual(accountDisplayOrder(null), []);
});

test('filter options are unique, sorted, and drop the unlabelled', () => {
  assert.deepEqual(uniqSorted(['b', 'a', '', 'a', null, undefined]), ['a', 'b']);
  assert.deepEqual(uniqSorted([]), []);
  assert.deepEqual(uniqSorted(null), []);
});

test('switchOutcome separates the choice being recorded from traffic following it', () => {
  assert.deepEqual(switchOutcome({ ok: true, account: 'b', eligible: true }), { kind: 'ok', text: 'switched to b' });
  // A spent or disabled target is still switched to (that is the TUI's behaviour),
  // but saying "done" would hide that rotation skips it on the very next request.
  assert.deepEqual(
    switchOutcome({ ok: true, account: 'b', eligible: false, reason: 'disabled by operator' }),
    { kind: 'warn', text: 'switched to b, but rotation will not use it: disabled by operator' },
  );
  assert.deepEqual(switchOutcome({ ok: false, error: 'no such account "x"' }), { kind: 'error', text: 'switch failed: no such account "x"' });
  assert.deepEqual(switchOutcome(null), { kind: 'error', text: 'switch failed' });
});

test('the switch button\'s request passes the same-origin gate and moves the current account', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'api_key', apiKey: 'sk-a' },
    { name: 'b', type: 'api_key', apiKey: 'sk-b' },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  const origin = `http://127.0.0.1:${port}`;
  const status = async () => (await fetch(`${origin}/teamclaude/status`, { headers: { 'x-api-key': 'secret' } })).json();
  try {
    assert.equal((await status()).currentAccount, 'a');

    // The request the page builds, plus the two headers a browser adds to a
    // same-origin fetch. This proves the CSRF gate, not the key: the test runs
    // on loopback, which the key gate exempts, so the key here is inert. Key
    // acceptance is covered in control-csrf.test.js; the gate is what the
    // button depends on, and it runs regardless of loopback.
    const r = switchRequest('b', 'secret');
    const ok = await fetch(origin + r.url, { ...r.init, headers: { ...r.init.headers, origin, 'sec-fetch-site': 'same-origin' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, account: 'b', eligible: true });
    assert.equal((await status()).currentAccount, 'b');

    // The same request from another site is refused — a page the operator
    // happens to visit cannot drive the button.
    const evil = await fetch(origin + r.url, { ...r.init, headers: { ...r.init.headers, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    assert.equal(evil.status, 403);
    assert.match((await evil.json()).error, /cross-origin/);
    assert.equal((await status()).currentAccount, 'b', 'unchanged');
  } finally {
    proxy.close();
  }
});

test('the dashboard exposes reload and one-shot probe controls', () => {
  const html = renderDashboardHtml();
  assert.match(html, /id="reload"/);
  assert.match(html, /id="probe"/);
  assert.match(html, /\/teamclaude\/reload/);
  assert.match(html, /\/teamclaude\/probe/);
});

test('the probe control invokes the server hook', async () => {
  let calls = 0;
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-x' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: 'http://127.0.0.1:9' }, {
    probeQuota: async () => { calls++; },
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/probe`, {
      method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
    });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(calls, 1);
  } finally {
    proxy.close();
  }
});

// The shape /teamclaude/status reports per route: the server's own target for
// the family, and every account with whether it could serve it.
const ROUTED = {
  currentAccount: 'a',
  routes: [{
    name: 'fable', match: ['*fable*'], autocreated: true, pinned: null, target: 'b',
    accounts: [{ name: 'a', eligible: false }, { name: 'b', eligible: true }, { name: 'c', eligible: true }],
  }],
};

test('dashboard payload identifies both provider cursors without one false global current', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'codex', type: 'oauth', provider: 'codex', accountId: 'acct', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex');

  const status = am.getStatus();
  assert.deepEqual(status.currentAccounts, { anthropic: 'claude', codex: 'codex' });
  const html = renderDashboardHtml();
  assert.match(html, /currentAccounts/);
  assert.match(html, /providerLabel/);
});

test('mixed-provider routing reports one default row per provider', () => {
  const rows = routeRows({
    currentAccount: 'codex',
    currentAccounts: { anthropic: 'claude', codex: 'codex' },
    defaultTargets: { anthropic: 'claude', codex: 'codex' },
    accounts: [
      { name: 'claude', provider: 'anthropic', unavailable: null },
      { name: 'codex', provider: 'codex', unavailable: null },
    ],
    routes: [{
      name: 'fable', provider: 'anthropic', match: ['*fable*'], target: 'claude',
      accounts: [{ name: 'claude', eligible: true }],
    }],
  });
  assert.deepEqual(
    rows.map(r => ({ label: r.label, provider: r.provider, target: r.target })),
    [
      { label: 'Fable', provider: 'anthropic', target: 'claude' },
      { label: 'Claude default', provider: 'anthropic', target: 'claude' },
      { label: 'Codex default', provider: 'codex', target: 'codex' },
    ],
  );
});

test('route rows say where each family goes, why, and where everything else goes', () => {
  const rows = routeRows(ROUTED);
  assert.equal(rows.length, 2);
  const [fable, rest] = rows;
  // A family diverted away from the current account shows the server's target,
  // not a re-derivation from quota bars, and names the accounts that cannot
  // take it — that is the reason the family is elsewhere.
  assert.deepEqual(
    { label: fable.label, match: fable.match, target: fable.target, eligible: fable.eligible, ineligible: fable.ineligible },
    { label: 'Fable', match: '*fable*', target: 'b', eligible: ['b', 'c'], ineligible: ['a'] },
  );
  assert.equal(fable.autocreated, true);
  // The default row is the current account: everything without a route lands there.
  assert.deepEqual({ label: rest.label, target: rest.target, match: rest.match }, { label: 'Everything else', target: 'a', match: '' });
});

test('a pinned route carries its pin, and says when routing is not honouring it', () => {
  const honoured = routeRows({ ...ROUTED, routes: [{ ...ROUTED.routes[0], pinned: 'c', target: 'c' }] })[0];
  assert.deepEqual({ pinned: honoured.pinned, target: honoured.target, mismatch: honoured.pinMismatch }, { pinned: 'c', target: 'c', mismatch: false });
  // The server skips a pin whose account cannot serve the family; "b · pinned"
  // would read as b being the pin. The row must carry both names.
  const skipped = routeRows({ ...ROUTED, routes: [{ ...ROUTED.routes[0], pinned: 'c', target: 'b' }] })[0];
  assert.deepEqual({ pinned: skipped.pinned, target: skipped.target, mismatch: skipped.pinMismatch }, { pinned: 'c', target: 'b', mismatch: true });
});

test('the default row is the server\'s defaultTarget, and says why when it is not the current account', () => {
  const blocked = { ...ROUTED, defaultTarget: 'b', accounts: [{ name: 'a', unavailable: 'throttled' }, { name: 'b', unavailable: null }] };
  const row = routeRows(blocked)[1];
  assert.equal(row.kind, 'default');
  assert.equal(row.target, 'b', 'not the current account');
  assert.equal(row.current, 'a');
  assert.equal(row.currentUnavailable, 'throttled');
  // Without defaultTarget (an older server) the row falls back to the current account.
  assert.equal(routeRows(ROUTED)[1].target, 'a');
});

test('a route whose every glob is blocked has no reachable target', () => {
  assert.equal(routeRows({ ...ROUTED, blockedModels: ['*fable*'] })[0].blocked, true);
  assert.equal(routeRows({ ...ROUTED, blockedModels: ['*opus*'] })[0].blocked, false);
  assert.equal(routeRows(ROUTED)[0].blocked, false);
  const empty = routeRows({ ...ROUTED, routes: [{ ...ROUTED.routes[0], target: null, accounts: [] }] })[0];
  assert.deepEqual({ target: empty.target, eligible: empty.eligible, ineligible: empty.ineligible }, { target: null, eligible: [], ineligible: [] });
});

test('route rows read the shape a real AccountManager reports', () => {
  const am = new AccountManager([
    { name: 'a', type: 'api_key', apiKey: 'sk-a' },
    { name: 'b', type: 'api_key', apiKey: 'sk-b' },
  ], 0.98);
  const H = 3600_000;
  Object.assign(am.accounts[0].quota, { unified7d: 0.3, unified7dReset: Date.now() + 4 * H, unified7dFable: 0.99, unified7dFableReset: Date.now() + 4 * H });
  Object.assign(am.accounts[1].quota, { unified7d: 0.1, unified7dReset: Date.now() + 90 * H, unified7dFable: 0.1, unified7dFableReset: Date.now() + 90 * H });
  const rows = routeRows(am.getStatus());
  const fable = rows.find(r => r.name === 'fable');
  assert.ok(fable, 'the server autocreates a Fable route once an account meters it');
  assert.deepEqual({ target: fable.target, ineligible: fable.ineligible }, { target: 'b', ineligible: ['a'] });
  assert.deepEqual({ target: rows[rows.length - 1].target, current: rows[rows.length - 1].current }, { target: 'a', current: 'a' });
  // The current account becomes unusable: the default row follows the server,
  // not the stale current name.
  am.setDisabled(0, true);
  const after = routeRows(am.getStatus())[rows.length - 1];
  assert.deepEqual({ target: after.target, current: after.current, why: after.currentUnavailable }, { target: 'b', current: 'a', why: 'disabled' });
});

test('a fleet with no routes renders no section', () => {
  // Without a metered family there is nothing to route: the summary line
  // already names the current account, so no redundant one-row table.
  assert.deepEqual(routeRows({ currentAccount: 'a', routes: [] }), []);
  assert.deepEqual(routeRows({ currentAccount: 'a' }), []);
  assert.deepEqual(routeRows(null), []);
});

// Built from a REAL getStatus() rather than a hand-written object: a previous
// version of this banner was validated against a payload the server can never
// emit, and the impossible fixture hid a false positive.
function fleetStatus(mutate) {
  const am = new AccountManager([
    { name: 'a', type: 'api_key', apiKey: 'sk-a' },
    { name: 'b', type: 'api_key', apiKey: 'sk-b' },
  ], 0.98);
  mutate?.(am);
  return am.getStatus({ sessionDetail: true });
}
/**
 * Drive a conversation to `n` consecutive no-answer outcomes on a real tracker.
 * `id` is the pin key; `labels` carries the session and conversation names the
 * request path attaches to it, which most cases here do not need.
 */
function starve(am, id, n, client = 'alice', labels = null) {
  for (let i = 0; i < n; i++) {
    am.beginSession(id, { client, dimensions: {}, ...labels });
    am.endSession(id, false);
  }
}

test('a starving session is named, and a working one is not', () => {
  const named = problems(fleetStatus(am => starve(am, 'deadbeef1234', STARVED_MIN)));
  assert.equal(named.length, 1);
  assert.equal(named[0].kind, 'starved-session');
  assert.equal(named[0].severity, 'bad');
  assert.match(named[0].text, /alice's session deadbeef/);
  assert.match(named[0].text, new RegExp(`${STARVED_MIN} requests in a row`));

  // One usable answer clears the streak — the session is working again.
  assert.deepEqual(problems(fleetStatus(am => {
    starve(am, 'deadbeef1234', STARVED_MIN);
    am.beginSession('deadbeef1234'); am.endSession('deadbeef1234', true);
  })), []);
  // Literals, not STARVED_MIN: written in terms of the constant, these passed
  // with the threshold set to 1 (fires on a single failure) and to 20 (never
  // fires). The value is part of the behaviour, so the test has to name it.
  assert.deepEqual(problems(fleetStatus(am => starve(am, 'deadbeef1234', 4))), [], 'four in a row is a wobble');
  assert.equal(problems(fleetStatus(am => starve(am, 'deadbeef1234', 5))).length, 1, 'five is an alarm');
  // A brand-new session, and a fleet doing nothing.
  assert.deepEqual(problems(fleetStatus(am => am.beginSession('fresh1234', { client: 'bob' }))), []);
  assert.deepEqual(problems(fleetStatus()), []);
});

test('a starving line names the session and the conversation, never the key', () => {
  // A fan-out starves as a group, so lines carrying only the session would read
  // as the same line repeated; the pin key that does separate them is a
  // composite an operator has never seen and cannot look up.
  const out = problems(fleetStatus(am => starve(am, 'deadbeef1234/AbCdEfGhIjKlMnOpQrStUv', STARVED_MIN, 'alice',
    { sessionId: 'deadbeef1234', conversation: 'AbCdEfGhIjKlMnOpQrStUv' })));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /alice's session deadbeef, conversation AbCdEfGh, has had/);
  assert.doesNotMatch(out[0].text, /\//);
});

test('a session that starved and then went quiet stops being reported', () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  starve(am, 'deadbeef1234', 9);
  assert.equal(problems(am.getStatus({ sessionDetail: true })).length, 1, 'reported while it is trying');
  // Past the active window: the row survives in items[] with its streak intact,
  // and only `active` keeps it out of the banner — deleting that filter passed
  // every other test in this file.
  const rec = am.sessionTracker.sessions.get('deadbeef1234');
  rec.lastSeen -= 5 * 60 * 1000;
  rec.inFlight = 0;
  const detailed = am.getStatus({ sessionDetail: true });
  assert.equal(detailed.sessions.items[0].starved, 9, 'the streak is still on the record');
  assert.deepEqual(problems(detailed), [], 'but a session that stopped trying is not starving');
  assert.deepEqual(problems(am.getStatus()), [], 'and the aggregate has cleared too');
});

test('many starving sessions are capped, worst first, with the rest counted', () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  const depth = { aaaaaaaa1111: 5, bbbbbbbb2222: 9, cccccccc3333: 6, dddddddd4444: 7, eeeeeeee5555: 8 };
  for (const [id, n] of Object.entries(depth)) starve(am, id, n, id.slice(0, 3));
  const out = problems(am.getStatus({ sessionDetail: true }));
  assert.equal(out.length, STARVED_LIST_MAX + 1, 'capped, plus one summary line');
  // Worst first — items[] arrives sorted by recency, which is a different order.
  assert.match(out[0].text, /bbbbbbbb/);
  assert.match(out[1].text, /eeeeeeee/);
  assert.match(out[2].text, /dddddddd/);
  assert.equal(out[3].kind, 'starved-more');
  assert.match(out[3].text, new RegExp(`and ${5 - STARVED_LIST_MAX} more`));
});

test('when the whole fleet is stalled the banner says so instead of blaming the session', () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  am.accounts[0].quota.unified5h = 0.99;              // over the switch threshold
  starve(am, 'deadbeef1234', 5);
  const out = problems(am.getStatus({ sessionDetail: true }));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /every account is over its quota threshold/);
  assert.doesNotMatch(out[0].text, /it is failing, not idle/);
});

test('without sessionDetail the banner still fires, unnamed', () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  starve(am, 'deadbeef1234', STARVED_MIN);
  const hidden = am.getStatus();               // sessionDetail off — no items[]
  assert.equal('items' in hidden.sessions, false);
  const out = problems(hidden);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'starved-session');
  assert.match(out[0].text, /proxy.sessionDetail/);
  // And it is not doubled when both the row and the aggregate are available.
  assert.equal(problems(am.getStatus({ sessionDetail: true })).length, 1);
});

test('only the account states that need a person are reported', () => {
  // These clear themselves — rotation and back-off working.
  // `status = 'exhausted'` is never assigned anywhere in src/, so a fixture that
  // sets it proves nothing. These four are all reachable.
  for (const quiet of [
    am => am.markRateLimited(0, 60),
    am => am.markEntitlementDenied(0),
    am => { am.accounts[0].maxUsage = 0.5; am.accounts[0].quota.unified5h = 0.9; },
    am => { am.accounts[0].quota.unifiedStatus = 'rejected'; am.accounts[0].quota.unifiedStatusSeenAt = Date.now(); },
  ]) assert.deepEqual(problems(fleetStatus(quiet)), [], 'self-clearing state must stay silent');

  // These do not.
  const broken = problems(fleetStatus(am => { am.accounts[0].status = 'error'; }));
  assert.deepEqual(broken.map(p => p.kind), ['account']);
  assert.match(broken[0].text, /re-login/);
  const off = problems(fleetStatus(am => am.setDisabled(0, true)));
  assert.deepEqual(off.map(p => p.kind), ['account']);
  assert.match(off[0].text, /disabled/);
});

test('overage spend is not a banner line', () => {
  // usedMinor is month-to-date, so once overage is switched on this would be lit
  // for most of the month. The account card and `teamclaude status` carry it,
  // with the amount, which the banner did not.
  assert.deepEqual(problems(fleetStatus(am => { am.accounts[0].quota.spend = { enabled: true, usedMinor: 250 }; })), []);
});

// Extra usage on the account card. Payload shapes as normalizeSpend reads them
// off /api/oauth/usage (see spend-warning.test.js for the live originals).
const billable = (usedMinor, extra = {}) => normalizeSpend({
  extra_usage: { is_enabled: true, currency: 'USD', decimal_places: 2, user_disabled: false, disabled_reason: null, ...extra },
  spend: {
    used: { amount_minor: usedMinor, currency: 'USD', exponent: 2 },
    limit: { amount_minor: 1000000, currency: 'USD', exponent: 2 },
  },
});

test('extraUsageText is silent for an account that cannot bill and has not', () => {
  assert.equal(extraUsageText(null), null);
  assert.equal(extraUsageText({ quota: {} }), null);
  assert.equal(extraUsageText({ quota: { spend: null } }), null);
  assert.equal(extraUsageText({ quota: { spend: normalizeSpend({
    extra_usage: { is_enabled: false }, spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 } },
  }) } }), null);
  assert.equal(extraUsageBar({ quota: { spend: null } }), null);
});

test('extraUsageText states the month\'s amount against the limit, and whether it is billing', () => {
  assert.equal(extraUsageText({ quota: { spend: billable(0) } }),
    'Extra usage: can bill past plan limits — $0.00 of $10,000.00 used this month');
  assert.equal(extraUsageText({ quota: { spend: billable(1435) } }),
    'Extra usage: billing — $14.35 of $10,000.00 used this month');
  assert.equal(extraUsageText({ maxSpend: 20, quota: { spend: billable(1435) } }),
    'Extra usage: billing — $14.35 of $10,000.00 used this month, cap $20.00');
  assert.equal(extraUsageText({ maxSpend: 20, quota: { spend: billable(2000) } }),
    'Extra usage: spend cap reached — $20.00 of $10,000.00 used this month, cap $20.00');
  // An invalid cap is no cap, as on the status screen and in the router.
  assert.doesNotMatch(extraUsageText({ maxSpend: -1, quota: { spend: billable(1435) } }), /cap/);
});

const switchedOff = (extra) => ({ quota: { spend: normalizeSpend({
  extra_usage: { is_enabled: false, ...extra },
  spend: {
    used: { amount_minor: 1500, currency: 'EUR', exponent: 2 },
    limit: { amount_minor: 2000, currency: 'EUR', exponent: 2 },
  },
}) } });

test('extraUsageText keeps a month\'s spend on an account switched off since, with why', () => {
  assert.equal(extraUsageText(switchedOff({ disabled_reason: 'out_of_credits' })),
    'Extra usage: €15.00 of €20.00 spent this month, now off (out_of_credits)');
  assert.match(extraUsageText(switchedOff({ user_disabled: true })), /now disabled by the account holder$/);
  assert.match(extraUsageText(switchedOff({})), /, now off$/);
});

test('extraUsageBar fills against upstream\'s monthly limit', () => {
  const bar = extraUsageBar({ quota: { spend: billable(1435) } });
  assert.equal(bar.ratio, 1435 / 1000000);
  assert.equal(bar.used, '$14.35');
  assert.equal(bar.rest, ' of $10,000.00');
  assert.equal(bar.off, false);
  assert.equal(bar.title, extraUsageText({ quota: { spend: billable(1435) } }));
  assert.deepEqual(extraUsageBar({ quota: { spend: billable(0) } }).ratio, 0);
  // Past the limit, as upstream reports it: the ratio is not clamped, the bar is.
  assert.ok(extraUsageBar({ quota: { spend: billable(1000100) } }).ratio > 1);
});

test('extraUsageBar fills against the maxSpend cap when it binds first, and says so', () => {
  const capped = extraUsageBar({ maxSpend: 20, quota: { spend: billable(1435) } });
  assert.equal(capped.ratio, 1435 / 2000);
  assert.equal(capped.used + capped.rest, '$14.35 of $20.00 cap');
  // A cap above the limit never binds: the limit is the ceiling shown.
  assert.equal(extraUsageBar({ maxSpend: 50000, quota: { spend: billable(1435) } }).rest, ' of $10,000.00');
  // "Not one cent": nothing spent is an empty bar, anything spent a full one.
  assert.equal(extraUsageBar({ maxSpend: 0, quota: { spend: billable(0) } }).ratio, 0);
  assert.equal(extraUsageBar({ maxSpend: 0, quota: { spend: billable(5) } }).ratio, 1);
});

test('extraUsageBar marks an account switched off since, and draws no ratio with no ceiling', () => {
  const off = extraUsageBar(switchedOff({ disabled_reason: 'out_of_credits' }));
  assert.equal(off.off, true);
  assert.equal(off.ratio, 0.75);
  assert.equal(off.used + off.rest, '€15.00 of €20.00 · off');
  const noLimit = extraUsageBar({ quota: { spend: normalizeSpend({
    extra_usage: { is_enabled: true }, spend: { used: { amount_minor: 4237, currency: 'USD', exponent: 2 } },
  }) } });
  assert.equal(noLimit.ratio, null);
  assert.equal(noLimit.used, '$42.37');
  assert.equal(noLimit.rest, '');
});

test('the extra-usage helpers run inside the serialized bundle, money helpers included', () => {
  // They call formatMoney, resolveMaxSpendMinor and spendCapReached by name,
  // and those are imported from oauth.js and model.js: the page has them only
  // because SHARED_HELPERS writes their source in.
  const script = inlineScripts(renderDashboardHtml()).at(-1);
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return { extraUsageText, extraUsageBar };`)();
  for (const a of [
    { quota: { spend: billable(0) } },
    { maxSpend: 20, quota: { spend: billable(1435) } },
    { maxSpend: 20, quota: { spend: billable(2000) } },
    switchedOff({ user_disabled: true }),
  ]) {
    assert.deepEqual(isolated.extraUsageText(a), extraUsageText(a));
    assert.deepEqual(isolated.extraUsageBar(a), extraUsageBar(a));
  }
});

test('the account card draws extra usage as a bar beside the weekly ones', async () => {
  const page = bootPage();
  await page.answer(200, {
    currentAccount: 'alice@example.com',
    accounts: [
      { name: 'alice@example.com', provider: 'anthropic', maxSpend: 20, quota: { unified5h: 0.1, unified7d: 1, spend: billable(1435) }, usage: {} },
      { name: 'bob@example.com', provider: 'anthropic', quota: { unified5h: 0.1, unified7d: 0.2 }, usage: {} },
    ],
  });
  assert.equal(page.labelled('Weekly'), 2);
  // Only the account that can bill carries one.
  assert.equal(page.labelled('Extra'), 1);
  assert.equal(page.labelled('$14.35'), 1);
  assert.equal(page.labelled(' of $20.00 cap'), 1);
});

test('the serialized helpers run in the page\'s own scope, not just parse', () => {
  // Parsing and grepping both pass for a helper that closes over a module
  // constant the page never ships — it would ReferenceError at first render.
  // Evaluate ONLY the serialized bundle and call into it.
  const html = renderDashboardHtml();
  const script = inlineScripts(html).at(-1);
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return problems;`)();
  const payload = { sessions: { items: [{ id: 'deadbeef1234', client: 'alice', active: true, starved: 9, requests: 9, pins: {}, tokens: {} }] } };
  assert.deepEqual(isolated(payload), problems(payload), 'the page runs what the tests exercise');
});

// The threshold badge specifically: accountBadges calls thresholdBadgeText by
// NAME, not by reference, so if the two ever land on different sides of the
// `bundle` slice (or thresholdBadgeText is dropped from SHARED_HELPERS while
// accountBadges keeps calling it) this is a page-breaking ReferenceError that
// grepping the source would not catch — only running the bundle does.
test('accountBadges calls thresholdBadgeText inside the same serialized bundle', () => {
  const html = renderDashboardHtml();
  const script = inlineScripts(html).at(-1);
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return accountBadges;`)();
  const account = { name: 'a', type: 'oauth', switchThreshold: 1.0 };
  assert.deepEqual(isolated(account, null, null, null, 0.98, null), accountBadges(account, null, null, null, 0.98, null));
});

// The bare number above never reaches the bucket tables: only a TABLE-form
// override reads THRESHOLD_BUCKET_KEYS and THRESHOLD_BUCKET_LABELS, and those
// are module constants the page does not see unless SHARED_CONSTS writes them
// in. Imported, the helper finds them in module scope and passes; in the page
// it threw a ReferenceError from render() and blanked the accounts pane.
test('a table-form override renders its badge inside the serialized bundle', () => {
  const html = renderDashboardHtml();
  const script = inlineScripts(html).at(-1);
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return accountBadges;`)();
  const account = { name: 'a', type: 'oauth', switchThreshold: { unified7d: 0.9, unified7dFable: 0.8 } };
  const badges = isolated(account, null, null, null, 0.98, null);
  assert.deepEqual(badges[badges.length - 1], { cls: 'meta threshold', text: 'switch 7d 90%, fable 80%' });
  // The inherited-bucket path reads the same two tables.
  const moved = isolated({ name: 'b', type: 'oauth', switchThreshold: 0.98 }, null, null, null, 0.98, { default: 0.98, unified7d: 0.85 });
  assert.deepEqual(moved[moved.length - 1], { cls: 'meta threshold', text: 'switch 7d 98%' });
});

// The "Switch at __ %" control. The stored setting is a 0–1 ratio quantised to
// tenths of a percent; the field shows the percentage, so the two have to agree
// or a re-save of what is on screen would change the setting.
test('thresholdPercentText shows the stored ratio as a percentage', () => {
  assert.equal(thresholdPercentText(0.98), '98');
  // No trailing zero: "98.0" in the box would read as a different number from
  // the 98 the status line and the CLI both print.
  assert.equal(thresholdPercentText(0.9), '90');
  assert.equal(thresholdPercentText(0.915), '91.5');
  assert.equal(thresholdPercentText(1), '100');
});

test('thresholdPercentText shows a per-bucket table as its default', () => {
  // The control sets one number for every bucket, so the default is the only
  // part of a table it can honestly show.
  assert.equal(thresholdPercentText({ default: 0.91, unified7d: 0.8 }), '91');
  // A config with no switchThreshold at all, and the array a hand edit can
  // produce: an empty field is better than a made-up number.
  assert.equal(thresholdPercentText(undefined), '');
  assert.equal(thresholdPercentText(null), '');
  assert.equal(thresholdPercentText([0.9]), '');
});

test('thresholdOutcome says when one number replaced a per-bucket table', () => {
  assert.deepEqual(
    thresholdOutcome({ ok: true, switchThreshold: 0.91, dropped: [] }),
    { kind: 'ok', text: 'switch threshold set to 91%' },
  );
  // A bare "saved" would hide the part the operator most needs to hear.
  const dropped = thresholdOutcome({ ok: true, switchThreshold: 0.9, dropped: ['unified7d', 'tokens'] });
  assert.equal(dropped.kind, 'warn');
  assert.match(dropped.text, /unified7d, tokens/);
  assert.deepEqual(
    thresholdOutcome({ ok: false, error: 'percent must be a number from 1 to 100' }),
    { kind: 'error', text: 'threshold change failed: percent must be a number from 1 to 100' },
  );
  assert.deepEqual(thresholdOutcome(null), { kind: 'error', text: 'threshold change failed' });
});

test('thresholdRequest posts the number to the control endpoint with the key', () => {
  const r = thresholdRequest(91.5, 'secret');
  assert.equal(r.url, '/teamclaude/threshold');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['x-api-key'], 'secret');
  assert.equal(r.init.body, '{"percent":91.5}');
  // A page that has no key yet still sends the header: loopback is exempt from
  // the key gate, and an absent header would be a different request shape.
  assert.equal(thresholdRequest(90, null).init.headers['x-api-key'], '');
});

test('the page carries the threshold control and wires it', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="thrVal"'), 'the percentage field');
  assert.ok(html.includes('id="thrSet"'), 'the Set button');
  assert.ok(html.includes("byId('thrSet').addEventListener"), 'the click handler');
  // Enter in the field is the same action: a number typed and left alone would
  // otherwise look applied without being saved.
  assert.ok(html.includes("byId('thrVal').addEventListener"), 'the Enter handler');
});

test('the page ships the same helper implementations it is tested against', () => {
  // The serialization is the contract: if a helper stops being self-contained
  // (closes over module scope), the page would silently ReferenceError.
  const html = renderDashboardHtml();
  for (const fn of [scopedWeeklyRows, accountTokens, accountTokenSplit, thresholdBadgeText, accountBadges, extraUsageText, extraUsageBar, meterTone, clientGroups, seriesLines, userLineNames, smoothPath, heatGrid, seriesTicks, sessionRows, filterSessionRows, sortRows, uniqSorted, switchRequest, switchOutcome, accountControlRequest, accountControlOutcome, thresholdRequest, thresholdPercentText, thresholdOutcome, routeRows, problems, usageFor, clientRanking, viewerCan, loginStartRequest, loginFinishRequest, loginOutcome, userRequest, userOutcome, rotateKeyRequest]) {
    assert.ok(html.includes(fn.toString()), `${fn.name} not serialized into the page`);
  }
  // Both the head bootstrap and the main script must parse, not just the last.
  for (const script of inlineScripts(html)) {
    assert.doesNotThrow(() => new Function(script), 'inline script must parse');
  }
});

// Run the page's whole inline script against a stub DOM, a stub localStorage and
// a fetch the test answers by hand. Elements absorb any method call, so render()
// runs without a real DOM; only the style and text the startup path sets are read.
function bootPage({ storedKey = null, storedTheme = null } = {}) {
  const els = new Map();
  // Listeners are recorded rather than absorbed, and every element built is
  // kept, so a test can drive a control the page created for itself — the
  // window buttons have no id to look up.
  const built = [];
  const stubEl = () => {
    // Listeners are recorded rather than absorbed, so a test can fire a click
    // the way the page registered it instead of reaching for an onclick the
    // page never sets. Every listener for a type is kept, in registration
    // order, since a page may attach more than one to the same element.
    const listeners = new Map();
    const target = {
      style: {}, value: '', textContent: '', className: '', disabled: false,
      addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      listens: type => (listeners.get(type) || []).length > 0,
    };
    const proxy = new Proxy(target, { get: (t, p) => (p in t ? t[p] : () => stubEl()) });
    // Fire with the proxy as `this`, the way the page sees the element, so a
    // handler that touches an unstubbed property gets the absorbing stub.
    target.fire = type => { for (const fn of listeners.get(type) || []) fn.call(proxy); };
    built.push(proxy);
    return proxy;
  };
  const byId = id => { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); };
  const store = new Map([
    ...(storedKey ? [['teamclaude-dashboard-key', storedKey]] : []),
    ...(storedTheme ? [['teamclaude-dashboard-theme', storedTheme]] : []),
  ]);
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const requests = [];
  const fetch = (url, init) => new Promise(resolve => requests.push({ url, init, resolve }));
  // documentElement is real enough to record the theme attribute, so a test can
  // assert what the page actually sets rather than that it merely did not throw.
  const rootAttrs = new Map();
  const documentElement = {
    setAttribute: (k, v) => rootAttrs.set(k, String(v)),
    removeAttribute: k => rootAttrs.delete(k),
    getAttribute: k => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
  };
  const docListeners = new Map();
  const document = {
    getElementById: byId, createElement: () => stubEl(), createElementNS: () => stubEl(), documentElement,
    addEventListener: (type, fn) => { if (!docListeners.has(type)) docListeners.set(type, []); docListeners.get(type).push(fn); },
  };
  const keydown = key => { for (const fn of docListeners.get('keydown') || []) fn({ key }); };
  const html = renderDashboardHtml();
  const script = inlineScripts(html).at(-1);
  new Function('document', 'localStorage', 'fetch', 'setInterval', 'clearInterval', script)(
    document, localStorage, fetch, () => 1, () => {});
  // The chart's history is its own fetch, sent after a status that shows a
  // client. `answer` resolves the oldest request that is NOT that one, so a
  // test about the controls reads the same whether or not a chart is on the
  // page; `answerSeries` resolves it.
  const isSeries = r => r.url === '/teamclaude/usage/series';
  const settle = async (index, status, body) => {
    assert.notEqual(index, -1, 'no such request pending');
    const [req] = requests.splice(index, 1);
    req.resolve({ status, ok: status >= 200 && status < 300, json: async () => body });
    await new Promise(r => setImmediate(r));
  };
  const answer = (status, body = {}) => settle(requests.findIndex(r => !isSeries(r)), status, body);
  const answerSeries = (body, status = 200) => settle(requests.findIndex(isSeries), status, body);
  const pending = () => requests.filter(r => !isSeries(r));
  // Click the control carrying this label, whoever built it. A render replaces
  // a table by building new elements rather than mutating the old ones, so the
  // mark is what keeps `labelled` counting what is on the page now instead of
  // everything ever built.
  let mark = 0;
  const click = label => {
    const el = built.find(e => e.textContent === label && e.listens('click'));
    assert.ok(el, `no clickable element labelled ${label}`);
    mark = built.length;
    el.fire('click');
  };
  const labelled = label => built.slice(mark).filter(e => e.textContent === label).length;
  // Two controls can carry one label (the page's window and measure buttons,
  // and Usage by user's own): `n` picks which, in the order they were built.
  const clickNth = (label, n) => {
    const el = built.filter(e => e.textContent === label && e.listens('click'))[n];
    assert.ok(el, `no clickable element #${n} labelled ${label}`);
    mark = built.length;
    el.fire('click');
  };
  // Controls that carry no text of their own (the settings gear) are found by
  // the title the page gives them.
  const clickTitled = title => {
    const el = built.find(e => e.title === title && e.listens('click'));
    assert.ok(el, `no clickable element titled ${title}`);
    mark = built.length;
    el.fire('click');
  };
  const titled = title => built.slice(mark).filter(e => e.title === title).length;
  // A field the page filled, such as a revealed key, found by its value.
  const valued = value => built.slice(mark).filter(e => e.value === value).length;
  return { byId, store, requests, pending, answer, answerSeries, rootAttrs, click, clickNth, clickTitled, titled, labelled, valued, keydown };
}

test('the page polls status before asking for a key, so a key-exempt browser is never prompted', async () => {
  const page = bootPage();
  assert.equal(page.requests.length, 1, 'polls on load with no stored key');
  assert.equal(page.requests[0].url, '/teamclaude/status');
  assert.equal(page.requests[0].init.headers['x-api-key'], '');
  assert.notEqual(page.byId('keybox').style.display, 'block', 'no prompt before the server answers');

  await page.answer(200, { accounts: [] });
  assert.notEqual(page.byId('keybox').style.display, 'block');
  assert.equal(page.byId('app').style.display, '');
});

for (const status of [401, 403]) {
  test(`a ${status} on the status poll brings the key prompt up and drops the stored key`, async () => {
    const page = bootPage({ storedKey: 'tc-stale' });
    assert.equal(page.requests[0].init.headers['x-api-key'], 'tc-stale');
    await page.answer(status);
    assert.equal(page.byId('keybox').style.display, 'block');
    assert.equal(page.byId('app').style.display, 'none');
    assert.equal(page.store.size, 0);
  });
}

test('a first poll that fails shows its error instead of a blank page', async () => {
  const page = bootPage();
  await page.answer(500);
  assert.equal(page.byId('err').style.display, 'flex');
  assert.match(page.byId('err').textContent, /status 500/);
  assert.equal(page.byId('app').style.display, '');
});

test('every id on the page is unique', () => {
  // Two elements sharing an id would have one of them drawn into the other's
  // place, the way getElementById answers only the first.
  const ids = [...renderDashboardHtml().matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test('Proxy status counts the accounts a request could go to, and names the blocked ones', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [
    { name: 'a' },
    { name: 'b', unavailable: 'throttled' },
    { name: 'c', disabled: true, unavailable: 'disabled' },
  ] });
  assert.equal(page.labelled('1 of 3'), 1);
  assert.equal(page.byId('acctCount').textContent, '1 of 3 active', 'and the Accounts heading agrees');
  assert.equal(page.byId('statServing').title, 'Blocked: b (upstream 429 hold), c (disabled by operator)');
});

test('the overview draws a column per client and switches measure without polling', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], clients: {
    alice: { requests: 3, inputTokens: 10, outputTokens: 90 },
    bob: { requests: 9, inputTokens: 5, outputTokens: 5 },
  } });
  assert.equal(page.byId('clientChartWrap').style.display, '');
  // The busiest client leads, its figure and share on its own column.
  assert.equal(page.byId('grp0Name').textContent, 'alice');
  assert.equal(page.byId('grp0Val').textContent, '100 tok');
  assert.equal(page.byId('grp0Pct').textContent, '91%');
  assert.equal(page.byId('grp1Name').textContent, 'bob');
  assert.equal(page.byId('grp2').style.display, 'none', 'two clients, two columns');
  // The big figure is every client's traffic on the window.
  assert.equal(page.byId('heroMain').textContent, '110');
  assert.equal(page.byId('heroLabel').textContent, 'Tokens used');
  assert.equal(page.byId('heroSplit').textContent, '15 in · 95 out', 'and under it, the two sides');
  assert.ok(page.byId('grp0').title.includes('(10 in · 90 out)'), "a column's tooltip splits its figure too");
  // Named by its column, its Clients row, and its Usage by user row and legend.
  assert.equal(page.labelled('alice'), 4);
  page.click('Requests');
  assert.equal(page.pending().length, 0, 'the measure re-renders the last status rather than fetching');
  assert.equal(page.byId('grp0Name').textContent, 'bob');
  assert.equal(page.byId('grp0Val').textContent, '9 req');
  assert.equal(page.byId('grp0Pct').textContent, '75%');
  assert.equal(page.byId('heroMain').textContent, '12');
  assert.equal(page.byId('heroLabel').textContent, 'Requests served');
  assert.equal(page.byId('heroSplit').style.display, 'none', 'requests have no sides');
});

test('without client keys the overview shows what the accounts served, and says so', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [
    { name: 'a', usage: { totalRequests: 4, totalInputTokens: 1000, totalOutputTokens: 200, totalCacheReadTokens: 800 } },
    { name: 'b', usage: { totalRequests: 1, totalOutputTokens: 500 } },
  ] });
  assert.equal(page.byId('heroMain').textContent, '2');
  assert.equal(page.byId('heroFrac').textContent, '.5k');
  assert.equal(page.byId('heroLabel').textContent, 'Tokens served since start');
  // Input carries the cache, as the total does: 1000 uncached + 800 read.
  assert.equal(page.byId('heroSplit').textContent, '1.8k in · 700 out');
  // Each card's footer splits its own spend the same way.
  assert.equal(page.labelled('4 req · 1.8k in · 200 out'), 1);
  assert.equal(page.byId('usageViewWrap').style.display, 'none', 'nothing windowed for the control to change');
});

test('viewerCan mirrors the server: operator everything, tenant the nudges, readonly nothing', () => {
  const actions = ['switch', 'reload', 'probe', 'accounts', 'threshold'];
  for (const a of actions) assert.equal(viewerCan({ role: 'operator' }, a), true, a);
  for (const a of actions) assert.equal(viewerCan({ role: 'readonly' }, a), false, a);
  assert.deepEqual(actions.filter(a => viewerCan({ role: 'tenant' }, a)), ['switch', 'reload', 'probe']);
  // A server older than the viewer field: everything shows, as it always did.
  for (const a of actions) assert.equal(viewerCan(undefined, a), true, a);
});

const ROLE_STATUS = viewer => ({
  viewer,
  currentAccount: 'alice@example.com',
  accounts: [
    { name: 'alice@example.com', provider: 'anthropic', quota: {}, usage: {} },
    { name: 'bob@example.com', provider: 'anthropic', quota: {}, usage: {} },
  ],
});

test('a read-only viewer is shown no controls, and told why', async () => {
  const page = bootPage();
  await page.answer(200, ROLE_STATUS({ client: 'watcher', role: 'readonly' }));
  // Every account control lives behind the settings gear, which it does not get.
  assert.equal(page.titled('Settings for alice@example.com'), 0);
  assert.equal(page.titled('Settings for bob@example.com'), 0);
  assert.equal(page.byId('reload').style.display, 'none');
  assert.equal(page.byId('probe').style.display, 'none');
  assert.equal(page.byId('thrWrap').style.display, 'none');
  assert.equal(page.labelled('watcher'), 1, 'the header names who is signed in');
  assert.equal(page.labelled('read-only'), 1, 'and as what');
});

test('an admin viewer gets every control', async () => {
  const page = bootPage();
  await page.answer(200, ROLE_STATUS({ client: 'boss', role: 'operator' }));
  assert.equal(page.titled('Settings for alice@example.com'), 1);
  assert.equal(page.titled('Settings for bob@example.com'), 1);
  assert.equal(page.byId('reload').style.display, '');
  assert.equal(page.byId('thrWrap').style.display, '');
  assert.equal(page.labelled('admin'), 1);

  // bob is not current: its dialog offers the switch, and the account controls.
  page.clickTitled('Settings for bob@example.com');
  assert.equal(page.byId('settingsWrap').style.display, '', 'the dialog opens');
  assert.equal(page.labelled('Switch'), 1);
  assert.equal(page.labelled('Priority'), 1);
  assert.equal(page.labelled('Enabled'), 1);
  // alice is current: the dialog says so instead of offering to switch.
  page.clickTitled('Settings for alice@example.com');
  assert.equal(page.labelled('In use'), 1);
  assert.equal(page.labelled('Switch'), 0);
});

test('the settings dialog sends the switch, the priority steps and the toggle', async () => {
  const page = bootPage();
  await page.answer(200, ROLE_STATUS({ client: 'boss', role: 'operator' }));
  page.clickTitled('Settings for bob@example.com');
  const sent = () => {
    const r = page.pending().at(-1);
    return { url: r.url, body: JSON.parse(r.init.body) };
  };
  page.click('Switch');
  assert.deepEqual(sent(), { url: '/teamclaude/switch', body: { account: 'bob@example.com' } });
  await page.answer(200, { ok: true, account: 'bob@example.com', eligible: true });
  // The number, not a rank: rotation picks the lowest first, so + moves it later.
  page.clickTitled('Settings for bob@example.com');
  page.click('+');
  assert.deepEqual(sent(), { url: '/teamclaude/priority', body: { account: 'bob@example.com', priority: 1 } });
  page.clickTitled('Settings for bob@example.com');
  page.click('−');
  assert.deepEqual(sent(), { url: '/teamclaude/priority', body: { account: 'bob@example.com', priority: -1 } });
  page.clickTitled('Disable bob@example.com');
  assert.deepEqual(sent(), { url: '/teamclaude/disable', body: { account: 'bob@example.com', disabled: true } });
});

test('a disabled account\'s dialog offers to enable it, not to switch to it', async () => {
  const page = bootPage();
  const status = ROLE_STATUS({ client: 'boss', role: 'operator' });
  status.accounts[1].disabled = true;
  await page.answer(200, status);
  page.clickTitled('Settings for bob@example.com');
  assert.equal(page.labelled('Switch'), 0);
  assert.equal(page.labelled('Enable it to switch'), 1);
  page.clickTitled('Enable bob@example.com');
  const r = page.pending().at(-1);
  assert.equal(r.url, '/teamclaude/disable');
  assert.deepEqual(JSON.parse(r.init.body), { account: 'bob@example.com', disabled: false });
});

test('a plain client key may switch from the dialog, and nothing more', async () => {
  const page = bootPage();
  await page.answer(200, ROLE_STATUS({ client: 'alice', role: 'tenant' }));
  page.clickTitled('Settings for bob@example.com');
  assert.equal(page.labelled('Switch'), 1);
  assert.equal(page.labelled('Priority'), 0);
  assert.equal(page.labelled('Enabled'), 0);
});

test('Escape closes the settings dialog', async () => {
  const page = bootPage();
  await page.answer(200, ROLE_STATUS({ client: 'boss', role: 'operator' }));
  page.clickTitled('Settings for bob@example.com');
  assert.equal(page.byId('settingsWrap').style.display, '');
  page.keydown('Escape');
  assert.equal(page.byId('settingsWrap').style.display, 'none');
});

test('Add account sends the start with the key and no body, and the finish with the trimmed code', () => {
  const start = loginStartRequest('tc-k');
  assert.equal(start.url, '/teamclaude/login/start');
  assert.equal(start.init.method, 'POST');
  assert.equal(start.init.headers['x-api-key'], 'tc-k');
  assert.equal(start.init.body, undefined);
  const finish = loginFinishRequest('st', '  abc#st\n', null);
  assert.equal(finish.url, '/teamclaude/login/finish');
  assert.deepEqual(JSON.parse(finish.init.body), { state: 'st', code: 'abc#st' });
  assert.equal(finish.init.headers['x-api-key'], '');
});

test('the Add account note says whether the account is new or signed in again', () => {
  assert.deepEqual(loginOutcome({ ok: true, action: 'added', name: 'n@x' }), { kind: 'ok', text: 'added account n@x' });
  assert.deepEqual(loginOutcome({ ok: true, action: 'updated', name: 'n@x' }), { kind: 'ok', text: 'signed in again as n@x' });
  assert.deepEqual(loginOutcome({ ok: false, error: 'the code was not accepted: invalid_grant' }),
    { kind: 'error', text: 'adding the account failed: the code was not accepted: invalid_grant' });
  assert.equal(loginOutcome(null).kind, 'error');
});

test('Add account: the link opens a panel, and a pasted code adds the account', async () => {
  const page = bootPage({ storedKey: 'tc-admin' });
  await page.answer(200, ROLE_STATUS({ client: 'boss', role: 'operator' }));
  assert.equal(page.byId('addAcct').style.display, '');
  page.byId('addAcct').fire('click');
  const start = page.requests.at(-1);
  assert.equal(start.url, '/teamclaude/login/start');
  assert.equal(start.init.headers['x-api-key'], 'tc-admin');
  await page.answer(200, { ok: true, url: 'https://claude.ai/oauth/authorize?state=st', state: 'st', expiresAt: Date.now() + 15 * 60 * 1000 });
  assert.equal(page.byId('loginWrap').style.display, '', 'the panel opens on the new link');
  assert.match(page.byId('loginNote').textContent, /15 minutes/);

  page.byId('loginCode').value = ' abc#st ';
  page.byId('loginGo').fire('click');
  const finish = page.requests.at(-1);
  assert.equal(finish.url, '/teamclaude/login/finish');
  assert.deepEqual(JSON.parse(finish.init.body), { state: 'st', code: 'abc#st' });
  await page.answer(200, { ok: true, action: 'added', name: 'new@example.com' });
  assert.equal(page.byId('loginWrap').style.display, 'none', 'the panel closes on success');
  assert.match(page.byId('note').textContent, /added account new@example\.com/);
});

test('Add account: a refused code keeps the panel open with the reason', async () => {
  const page = bootPage({ storedKey: 'tc-admin' });
  await page.answer(200, ROLE_STATUS({ client: 'boss', role: 'operator' }));
  page.byId('addAcct').fire('click');
  await page.answer(200, { ok: true, url: 'https://claude.ai/oauth/authorize?state=st', state: 'st', expiresAt: Date.now() + 60000 });
  page.byId('loginCode').value = 'wrong';
  page.byId('loginGo').fire('click');
  await page.answer(400, { ok: false, error: 'the code was not accepted: invalid_grant' });
  assert.equal(page.byId('loginWrap').style.display, '');
  assert.match(page.byId('loginNote').textContent, /invalid_grant/);
  assert.equal(page.byId('loginNote').className, 'error');
});

test('Add account is not offered to a read-only viewer', async () => {
  const page = bootPage();
  await page.answer(200, ROLE_STATUS({ client: 'watcher', role: 'readonly' }));
  assert.equal(page.byId('addAcct').style.display, 'none');
  assert.equal(page.byId('loginWrap').style.display, 'none');
});

// ── Users card ───────────────────────────────────────────────────────────────

test('userRequest posts each user change with the key, and only the fields it names', () => {
  const add = userRequest('add', { name: ' dave ', role: 'readonly' }, 'tc-k');
  assert.equal(add.url, '/teamclaude/users/add');
  assert.equal(add.init.method, 'POST');
  assert.equal(add.init.headers['x-api-key'], 'tc-k');
  assert.deepEqual(JSON.parse(add.init.body), { name: 'dave', role: 'readonly' }, 'the typed name is trimmed');
  const rm = userRequest('remove', { name: 'bob', role: 'admin' }, null);
  assert.equal(rm.url, '/teamclaude/users/remove');
  assert.deepEqual(JSON.parse(rm.init.body), { name: 'bob' });
  assert.equal(rm.init.headers['x-api-key'], '');
  const role = userRequest('role', { name: 'bob', role: 'admin' }, 'tc-k');
  assert.equal(role.url, '/teamclaude/users/role');
  assert.deepEqual(JSON.parse(role.init.body), { name: 'bob', role: 'admin' });
});

test('userOutcome names what changed, or why it did not', () => {
  assert.deepEqual(userOutcome('add', { ok: true, name: 'dave', role: 'tenant', key: 'tc-x' }), { kind: 'ok', text: 'added user dave' });
  assert.deepEqual(userOutcome('remove', { ok: true, name: 'bob', removed: 1 }), { kind: 'ok', text: 'removed user bob' });
  assert.deepEqual(userOutcome('role', { ok: true, name: 'bob', role: 'readonly' }), { kind: 'ok', text: 'bob is now read-only' });
  assert.deepEqual(userOutcome('role', { ok: true, name: 'bob', role: 'tenant' }), { kind: 'ok', text: 'bob is now a user' });
  assert.deepEqual(userOutcome('remove', { ok: false, error: 'There is no user named "zed".' }),
    { kind: 'error', text: 'removing the user failed: There is no user named "zed".' });
  assert.equal(userOutcome('add', null).kind, 'error');
  assert.ok(!userOutcome('add', { ok: true, name: 'dave', key: 'tc-secret' }).text.includes('tc-secret'), 'the note never carries the key');
});

test("userRequest asks for one user's keys; rotateKeyRequest sends only the key", () => {
  const key = userRequest('key', { name: ' bob ', role: 'admin' }, 'tc-k');
  assert.equal(key.url, '/teamclaude/users/key');
  assert.deepEqual(JSON.parse(key.init.body), { name: 'bob' });
  const rot = rotateKeyRequest('tc-bob');
  assert.equal(rot.url, '/teamclaude/me/rotate');
  assert.equal(rot.init.method, 'POST');
  assert.equal(rot.init.headers['x-api-key'], 'tc-bob');
  assert.equal(rot.init.body, undefined);
  assert.equal(rotateKeyRequest(null).init.headers['x-api-key'], '');
});

test('userOutcome never repeats a revealed or rotated key', () => {
  const shown = userOutcome('key', { ok: true, name: 'bob', keys: ['tc-bob-secret'] });
  assert.equal(shown.kind, 'ok');
  assert.ok(!shown.text.includes('tc-bob-secret'));
  assert.deepEqual(userOutcome('rotate', { ok: true, name: 'bob', key: 'tc-new-secret' }), { kind: 'ok', text: 'rotated your key' });
  assert.deepEqual(userOutcome('rotate', { ok: false, error: 'nope' }), { kind: 'error', text: 'rotating the key failed: nope' });
  assert.equal(userOutcome('key', { ok: false }).text, 'showing the key failed');
});

test('viewerCan offers rotating to any named key, and to no one without a name', () => {
  for (const role of ['operator', 'tenant', 'readonly']) assert.equal(viewerCan({ client: 'bob', role }, 'rotate'), true, role);
  assert.equal(viewerCan({ client: null, role: 'operator' }, 'rotate'), false, 'the shared key has no key of its own');
  assert.equal(viewerCan(null, 'rotate'), false);
});

test('viewerCan keeps users to the operator', () => {
  assert.equal(viewerCan({ role: 'operator' }, 'users'), true);
  assert.equal(viewerCan({ role: 'tenant' }, 'users'), false);
  assert.equal(viewerCan({ role: 'readonly' }, 'users'), false);
});

const USERS_STATUS = viewer => ({
  ...ROLE_STATUS(viewer),
  users: [
    { name: 'alice', role: 'admin' },
    { name: 'bob', role: 'tenant' },
    { name: 'carol', role: 'readonly' },
  ],
});

test('the Users card lists every user for an operator, and is hidden from everyone else', async () => {
  const op = bootPage();
  await op.answer(200, USERS_STATUS({ client: null, role: 'operator' }));
  assert.equal(op.byId('userAdminSec').style.display, '');
  assert.ok(op.byId('addUser').listens('click'), 'Add user sits in the card and is wired');
  for (const n of ['alice', 'bob', 'carol']) assert.equal(op.titled(`Remove ${n}`), 1, n);
  assert.equal(op.labelled('3 users'), 1);

  for (const role of ['tenant', 'readonly']) {
    const page = bootPage();
    // A server never sends `users` to these; the card must not rely on that.
    await page.answer(200, USERS_STATUS({ client: 'bob', role }));
    assert.equal(page.byId('userAdminSec').style.display, 'none', role);
    assert.equal(page.titled('Remove carol'), 0, role);
  }
});

test('an admin is not offered removing or demoting their own key', async () => {
  const page = bootPage();
  await page.answer(200, USERS_STATUS({ client: 'alice', role: 'operator' }));
  assert.equal(page.titled('Remove alice'), 0);
  assert.equal(page.titled('Make alice read-only'), 0);
  assert.equal(page.titled('Remove bob'), 1);
  assert.equal(page.titled('Make bob admin'), 1);
});

test('Add user: the key is shown once, and gone when the dialog closes', async () => {
  const page = bootPage({ storedKey: 'tc-admin' });
  await page.answer(200, USERS_STATUS({ client: null, role: 'operator' }));
  page.byId('addUser').fire('click');
  assert.equal(page.byId('userWrap').style.display, '', 'the dialog opens');
  assert.equal(page.byId('userForm').style.display, '');
  assert.equal(page.byId('userKeyWrap').style.display, 'none');

  page.byId('userNameIn').value = ' dave ';
  page.clickTitled('New user role: Read-only');
  page.byId('userGo').fire('click');
  const req = page.requests.at(-1);
  assert.equal(req.url, '/teamclaude/users/add');
  assert.equal(req.init.headers['x-api-key'], 'tc-admin');
  assert.deepEqual(JSON.parse(req.init.body), { name: 'dave', role: 'readonly' });

  await page.answer(200, { ok: true, name: 'dave', role: 'readonly', key: 'tc-dave-secret' });
  assert.equal(page.byId('userForm').style.display, 'none');
  assert.equal(page.byId('userKeyWrap').style.display, '', 'the key view replaces the form');
  assert.equal(page.byId('userKey').value, 'tc-dave-secret');
  assert.match(page.byId('userNote').textContent, /won.t be shown again/);
  assert.match(page.byId('note').textContent, /added user dave/);
  assert.ok(!page.byId('note').textContent.includes('tc-dave-secret'));

  page.byId('userDone').fire('click');
  assert.equal(page.byId('userWrap').style.display, 'none');
  assert.equal(page.byId('userKey').value, '', 'the key does not stay in the page');
});

test('Add user: a refused name keeps the form open with the reason', async () => {
  const page = bootPage();
  await page.answer(200, USERS_STATUS({ client: null, role: 'operator' }));
  page.byId('addUser').fire('click');
  page.byId('userNameIn').value = 'bob';
  page.byId('userGo').fire('click');
  await page.answer(400, { ok: false, error: 'There is already a user named "bob".' });
  assert.equal(page.byId('userWrap').style.display, '');
  assert.equal(page.byId('userForm').style.display, '');
  assert.equal(page.byId('userNote').className, 'error');
  assert.match(page.byId('userNote').textContent, /already a user named "bob"/);

  // An empty name never leaves the page.
  const before = page.requests.length;
  page.byId('userNameIn').value = '   ';
  page.byId('userGo').fire('click');
  assert.equal(page.requests.length, before);
  assert.match(page.byId('userNote').textContent, /name/);
});

test('Remove asks once more before it sends', async () => {
  const page = bootPage();
  await page.answer(200, USERS_STATUS({ client: null, role: 'operator' }));
  const before = page.requests.length;
  page.clickTitled('Remove bob');
  assert.equal(page.requests.length, before, 'the first click only asks');
  assert.equal(page.labelled('Confirm'), 1);
  page.clickTitled('Remove bob');
  const req = page.requests.at(-1);
  assert.equal(req.url, '/teamclaude/users/remove');
  assert.deepEqual(JSON.parse(req.init.body), { name: 'bob' });
  await page.answer(200, { ok: true, name: 'bob', removed: 1 });
  assert.match(page.byId('note').textContent, /removed user bob/);
  assert.equal(page.pending().at(-1).url, '/teamclaude/status', 'the list is refreshed from the server');
});

test('a role button sends the change, and a refusal is shown', async () => {
  const page = bootPage();
  await page.answer(200, USERS_STATUS({ client: null, role: 'operator' }));
  page.clickTitled('Make bob admin');
  const req = page.requests.at(-1);
  assert.equal(req.url, '/teamclaude/users/role');
  assert.deepEqual(JSON.parse(req.init.body), { name: 'bob', role: 'admin' });
  await page.answer(400, { ok: false, error: 'There is no user named "bob".' });
  assert.match(page.byId('note').textContent, /changing the role failed/);
});

test("Show key reveals a user's keys on request, and Hide takes them off the page", async () => {
  const page = bootPage({ storedKey: 'tc-alice' });
  await page.answer(200, USERS_STATUS({ client: 'alice', role: 'operator' }));
  for (const n of ['alice', 'bob', 'carol']) assert.equal(page.titled('Show key of ' + n), 1, n);
  assert.equal(page.valued('tc-bob'), 0, 'no key is on the page before it is asked for');

  page.clickTitled('Show key of bob');
  const req = page.requests.at(-1);
  assert.equal(req.url, '/teamclaude/users/key');
  assert.equal(req.init.headers['x-api-key'], 'tc-alice');
  assert.deepEqual(JSON.parse(req.init.body), { name: 'bob' });
  await page.answer(200, { ok: true, name: 'bob', keys: ['tc-bob', 'tc-bob-2'] });
  assert.equal(page.valued('tc-bob'), 1);
  assert.equal(page.valued('tc-bob-2'), 1, 'every key of the name');
  assert.ok(!page.byId('note').textContent.includes('tc-bob'), 'the note never carries a key');

  page.clickTitled('Hide key of bob');
  assert.equal(page.valued('tc-bob'), 0);
  assert.equal(page.titled('Show key of bob'), 1);
});

test('a refused Show key says why and shows nothing', async () => {
  const page = bootPage();
  await page.answer(200, USERS_STATUS({ client: null, role: 'operator' }));
  page.clickTitled('Show key of bob');
  await page.answer(400, { ok: false, error: 'There is no user named "bob".' });
  assert.match(page.byId('note').textContent, /showing the key failed: There is no user named "bob"/);
  assert.equal(page.titled('Hide key of bob'), 0);
});

test('Rotate key: asks once more, then stores and shows the new key once', async () => {
  const page = bootPage({ storedKey: 'tc-bob' });
  await page.answer(200, ROLE_STATUS({ client: 'bob', role: 'tenant' }));
  assert.equal(page.byId('me').disabled, false, 'the avatar opens your key');
  page.byId('me').fire('click');
  assert.equal(page.byId('keyWrap').style.display, '');
  assert.equal(page.byId('keyForm').style.display, '');
  assert.equal(page.byId('keyNewWrap').style.display, 'none');

  const before = page.requests.length;
  page.byId('keyRotate').fire('click');
  assert.equal(page.requests.length, before, 'the first click only asks');
  assert.equal(page.byId('keyRotate').textContent, 'Confirm rotate');
  page.byId('keyRotate').fire('click');
  const req = page.requests.at(-1);
  assert.equal(req.url, '/teamclaude/me/rotate');
  assert.equal(req.init.headers['x-api-key'], 'tc-bob');

  await page.answer(200, { ok: true, name: 'bob', key: 'tc-bob-new' });
  assert.equal(page.store.get('teamclaude-dashboard-key'), 'tc-bob-new', 'the page stays signed in with the new key');
  assert.equal(page.byId('keyForm').style.display, 'none');
  assert.equal(page.byId('keyNewWrap').style.display, '');
  assert.equal(page.byId('keyNew').value, 'tc-bob-new');
  assert.match(page.byId('keyNote').textContent, /won.t be shown again/);
  assert.ok(!page.byId('note').textContent.includes('tc-bob-new'));
  assert.equal(page.pending().at(-1).init.headers['x-api-key'], 'tc-bob-new', 'the next poll uses the new key');

  page.keydown('Escape');
  assert.equal(page.byId('keyWrap').style.display, '', 'a stray Escape does not throw the new key away');
  page.byId('keyDone').fire('click');
  assert.equal(page.byId('keyWrap').style.display, 'none');
  assert.equal(page.byId('keyNew').value, '', 'the key does not stay in the page');
});

test('a refused rotation keeps the stored key and says why', async () => {
  const page = bootPage({ storedKey: 'tc-bob' });
  await page.answer(200, ROLE_STATUS({ client: 'bob', role: 'readonly' }));
  page.byId('me').fire('click');
  page.byId('keyRotate').fire('click');
  page.byId('keyRotate').fire('click');
  await page.answer(400, { ok: false, error: 'That key is no longer in the config, so there is nothing to rotate.' });
  assert.equal(page.store.get('teamclaude-dashboard-key'), 'tc-bob');
  assert.equal(page.byId('keyForm').style.display, '');
  assert.equal(page.byId('keyNote').className, 'error');
  assert.match(page.byId('keyNote').textContent, /no longer in the config/);
});

test('the shared key has no key of its own, so the avatar opens nothing', async () => {
  const page = bootPage({ storedKey: 'tc-shared' });
  await page.answer(200, ROLE_STATUS({ client: null, role: 'operator' }));
  assert.equal(page.byId('me').disabled, true);
  page.byId('me').fire('click');
  assert.notEqual(page.byId('keyWrap').style.display, '');
});

test('the Most used chart stays hidden until a client key has been used', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [] });
  assert.equal(page.byId('clientChartWrap').style.display, 'none');
});

test('dashboard page is self-contained: no external resources', () => {
  const html = renderDashboardHtml();
  assert.match(html, /^<!doctype html>/);
  // The CSP story for a page that holds the proxy key in localStorage depends
  // on nothing external ever loading — no CDN scripts, styles, or fonts.
  assert.doesNotMatch(html, /src\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /href\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /@import/i);
  // The data fetch targets the gated status endpoint, same origin.
  assert.match(html, /fetch\('\/teamclaude\/status'/);
});

test('GET /teamclaude/dashboard serves HTML without a key; other methods are a local 404', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ upstream: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-x' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /TeamClaude/);

    // The page keeps the proxy key in localStorage, so it ships with a policy
    // that lets nothing load from anywhere and admits only its own script —
    // by hash, so a script that is not byte-for-byte this one does not run.
    const csp = page.headers.get('content-security-policy');
    assert.ok(csp, 'the dashboard must carry a Content-Security-Policy');
    assert.equal(csp, dashboardCsp(html));
    assert.match(csp, /(^|; )default-src 'none'(;|$)/);
    assert.match(csp, /(^|; )connect-src 'self'(;|$)/);
    assert.match(csp, /(^|; )frame-ancestors 'none'(;|$)/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    // Every inline script is admitted by hash, not just the first: the theme
    // is applied by a short script in <head>, and a policy covering only the
    // main script would block it and paint the page dark for a light viewer.
    const scripts = inlineScripts(html);
    assert.ok(scripts.length >= 2, 'the page has a head script and a main script');
    for (const script of scripts) {
      const hash = createHash('sha256').update(script, 'utf8').digest('base64');
      assert.match(csp, new RegExp(`'sha256-${hash.replace(/[+/=]/g, '\\$&')}'`));
    }
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

    // The asset route is GET + exact path only — a POST to the same path must
    // NOT hit the dashboard handler. It used to flow on to the forwarder and
    // reach the upstream under a fleet credential; an unclaimed path under the
    // proxy's own prefix is now answered here (#420).
    const post = await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard`, { method: 'POST' });
    assert.equal(post.status, 404);
    assert.match((await post.json()).error, /unknown teamclaude control route/);
    assert.equal(upstreamHits, 0);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('the theme starts from what was stored, and system means no attribute', () => {
  // No stored choice: the attribute is absent, so the media query decides and a
  // viewer who never touches this keeps following their desktop.
  assert.equal(bootPage().rootAttrs.get('data-theme'), undefined);
  assert.equal(bootPage({ storedTheme: 'light' }).rootAttrs.get('data-theme'), 'light');
  assert.equal(bootPage({ storedTheme: 'dark' }).rootAttrs.get('data-theme'), 'dark');
  // Junk in storage is not a theme; fall back to following the system rather
  // than writing an attribute no stylesheet matches.
  assert.equal(bootPage({ storedTheme: 'neon' }).rootAttrs.get('data-theme'), undefined);
});

test('the theme button cycles system -> light -> dark and persists each step', () => {
  const page = bootPage();
  const click = () => page.byId('theme').fire('click');
  const stored = () => page.store.get('teamclaude-dashboard-theme');

  // An icon button: the state it names is its title (and its aria-label).
  assert.equal(page.byId('theme').title, 'Theme: system');
  assert.equal(stored(), undefined, 'following the system stores nothing');

  click();
  assert.equal(page.rootAttrs.get('data-theme'), 'light');
  assert.equal(stored(), 'light');
  assert.equal(page.byId('theme').title, 'Theme: light');

  click();
  assert.equal(page.rootAttrs.get('data-theme'), 'dark');
  assert.equal(stored(), 'dark');

  // Back to system: the attribute goes away AND the stored value is removed,
  // so the page does not keep re-applying a choice the viewer just dropped.
  click();
  assert.equal(page.rootAttrs.get('data-theme'), undefined);
  assert.equal(stored(), undefined);
  assert.equal(page.byId('theme').title, 'Theme: system');
});

test('a stored dark choice survives a reload', () => {
  const first = bootPage();
  first.byId('theme').fire('click');
  first.byId('theme').fire('click');
  assert.equal(first.store.get('teamclaude-dashboard-theme'), 'dark');
  // A fresh page with that storage comes up dark without another click.
  const reloaded = bootPage({ storedTheme: first.store.get('teamclaude-dashboard-theme') });
  assert.equal(reloaded.rootAttrs.get('data-theme'), 'dark');
  assert.equal(reloaded.byId('theme').title, 'Theme: dark');
});

test('accountControlRequest picks the endpoint and body from the spec', () => {
  // A relative move sends `place` and no number: the caller has buttons, not a
  // number field, and the server is the one that knows the other priorities.
  const first = accountControlRequest('a@x.com', { place: 'first' }, 'k');
  assert.equal(first.url, '/teamclaude/priority');
  assert.deepEqual(JSON.parse(first.init.body), { account: 'a@x.com', place: 'first' });
  assert.equal(first.init.headers['x-api-key'], 'k');

  const exact = accountControlRequest('a@x.com', { priority: 3 }, 'k');
  assert.deepEqual(JSON.parse(exact.init.body), { account: 'a@x.com', priority: 3 });

  // disabled:false is a real value, not an absent one — it must still route to
  // the disable endpoint rather than being read as a priority change.
  const off = accountControlRequest('a@x.com', { disabled: true }, 'k');
  assert.equal(off.url, '/teamclaude/disable');
  assert.deepEqual(JSON.parse(off.init.body), { account: 'a@x.com', disabled: true });
  const on = accountControlRequest('a@x.com', { disabled: false }, 'k');
  assert.equal(on.url, '/teamclaude/disable');
  assert.deepEqual(JSON.parse(on.init.body), { account: 'a@x.com', disabled: false });

  // No key configured is not an error here; the server decides.
  assert.equal(accountControlRequest('a@x.com', { place: 'last' }, null).init.headers['x-api-key'], '');
});

test('accountControlOutcome reports the number a relative move landed on', () => {
  assert.deepEqual(
    accountControlOutcome({ ok: true, name: 'a@x.com', priority: -1 }, { place: 'first' }),
    { kind: 'ok', text: 'a@x.com priority -1' });
  assert.deepEqual(
    accountControlOutcome({ ok: true, name: 'a@x.com', disabled: true }, { disabled: true }),
    { kind: 'ok', text: 'disabled a@x.com' });
  assert.deepEqual(
    accountControlOutcome({ ok: true, name: 'a@x.com', disabled: false }, { disabled: false }),
    { kind: 'ok', text: 'enabled a@x.com' });
  assert.deepEqual(
    accountControlOutcome({ ok: false, error: 'no account matches "z"' }, { place: 'first' }),
    { kind: 'error', text: 'change failed: no account matches "z"' });
  assert.deepEqual(
    accountControlOutcome(null, { place: 'first' }),
    { kind: 'error', text: 'change failed' });
});

// ── usage windows ───────────────────────────────────────────

const ENTRY = {
  requests: 100, connections: 4, inputTokens: 9000, outputTokens: 500,
  windows: {
    '5h': { requests: 3, connections: 0, inputTokens: 300, outputTokens: 20 },
    '24h': { requests: 12, connections: 1, inputTokens: 1200, outputTokens: 80 },
  },
};

test('the total view reads the lifetime counters', () => {
  assert.deepEqual(usageFor(ENTRY, 'total'), { requests: 100, connections: 4, inputTokens: 9000, outputTokens: 500 });
  // No view at all is the same question, asked before the page has state.
  assert.deepEqual(usageFor(ENTRY), usageFor(ENTRY, 'total'));
});

test('a window view reads that window, not the lifetime counters', () => {
  assert.deepEqual(usageFor(ENTRY, '24h'), { requests: 12, connections: 1, inputTokens: 1200, outputTokens: 80 });
  assert.equal(usageFor(ENTRY, '5h').inputTokens, 300);
});

test('a window the payload does not carry reads as zero, never as the total', () => {
  // The alternative — falling back to the lifetime figure — would label an
  // all-time number as a five-hour one, which is the one answer that misleads
  // rather than merely disappoints.
  assert.deepEqual(usageFor({ requests: 7, inputTokens: 5 }, '24h'), { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(usageFor(null, '5h'), { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(usageFor(undefined, 'total'), { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 });
});

test('every offered view names a window the tracker actually keeps', () => {
  // The buttons are derived from USAGE_WINDOWS rather than listed twice: a
  // renamed window must not leave behind a button that reads zero for everyone.
  assert.equal(USAGE_VIEWS[0].key, 'total');
  assert.deepEqual(USAGE_VIEWS.slice(1).map(v => v.key), Object.keys(USAGE_WINDOWS));
  for (const view of USAGE_VIEWS) assert.ok(view.label, 'every view carries a button label');
});

test('the page ships the view list it renders buttons from', () => {
  assert.ok(renderDashboardHtml().includes(`var USAGE_VIEWS = ${JSON.stringify(USAGE_VIEWS)};`));
});

const CLIENTS = {
  alice: { requests: 4, inputTokens: 100, outputTokens: 500, lastUsed: '2026-09-28T10:00:00.000Z',
    windows: { '5h': { requests: 1, inputTokens: 10, outputTokens: 20 } } },
  bob: { requests: 20, inputTokens: 50, outputTokens: 150,
    windows: { '5h': { requests: 6, inputTokens: 40, outputTokens: 50 } } },
  carol: { requests: 0, inputTokens: 0, outputTokens: 0 },
};

test('the chart ranks clients by tokens on the shown window, largest first', () => {
  const total = clientRanking(CLIENTS, 'total', 'tokens');
  assert.deepEqual(total.map(r => [r.name, r.value]), [['alice', 600], ['bob', 200], ['carol', 0]]);
  // A bar's length is against the largest bar, its percentage against the sum.
  assert.equal(total[0].ratio, 1);
  assert.equal(total[1].ratio, 200 / 600);
  assert.equal(total[1].share, 200 / 800);
  assert.equal(total[0].lastUsed, '2026-09-28T10:00:00.000Z');
  // The window reorders the ranking rather than filtering the lifetime one:
  // bob is the busier client of the last five hours.
  assert.deepEqual(clientRanking(CLIENTS, '5h', 'tokens').map(r => [r.name, r.value]), [['bob', 90], ['alice', 30], ['carol', 0]]);
});

test('the chart can rank by requests instead', () => {
  const rows = clientRanking(CLIENTS, 'total', 'requests');
  assert.deepEqual(rows.map(r => [r.name, r.value]), [['bob', 20], ['alice', 4], ['carol', 0]]);
  assert.equal(rows[0].share, 20 / 24);
});

test('equal clients keep a stable order, and nothing spent shares nothing', () => {
  // Ties fall back to the name, or two equal bars would swap on every poll.
  const tied = clientRanking({ zed: { requests: 1 }, amy: { requests: 1 } }, 'total', 'requests');
  assert.deepEqual(tied.map(r => r.name), ['amy', 'zed']);
  // An idle fleet has no total to divide by: zero shares, never NaN widths.
  for (const r of clientRanking({ a: {}, b: {} }, '5h', 'tokens')) {
    assert.equal(r.share, 0);
    assert.equal(r.ratio, 0);
  }
  assert.deepEqual(clientRanking(null, 'total', 'tokens'), []);
  assert.deepEqual(clientRanking(undefined), []);
});

test('selecting a window relabels every table it governs', async () => {
  const page = bootPage();
  const windows = { '5h': { requests: 1, connections: 0, inputTokens: 10, outputTokens: 2 },
    '24h': { requests: 9, connections: 0, inputTokens: 900, outputTokens: 40 } };
  await page.answer(200, {
    accounts: [],
    clients: { alice: { requests: 99, connections: 0, inputTokens: 9000, outputTokens: 400, lastUsed: new Date().toISOString(), windows } },
    usageDimensions: { project: { widgets: { requests: 99, inputTokens: 9000, outputTokens: 400, windows } } },
  });

  assert.equal(page.byId('clientsHeading').textContent, 'Clients');
  assert.equal(page.labelled('Last used'), 1, 'the dimension table labels the column plainly under Total');
  assert.equal(page.labelled('Project'), 2, 'the dimension heading and its first column');

  page.click('Last 24h');

  // The heading is what stops a windowed figure being read as a lifetime one
  // once the control itself is scrolled out of view.
  assert.equal(page.byId('clientsHeading').textContent, 'Clients · last 24h');
  assert.equal(page.labelled('Project · last 24h'), 1, 'the dimension table names the window too');
  assert.equal(page.labelled('Last used (all time)'), 1, 'and the one lifetime column says so');
  assert.equal(page.labelled('Last used'), 0);
  assert.equal(page.byId('rangeStart').textContent, '24 hours ago', 'the overview names where its span starts');

  page.click('Total');
  assert.equal(page.byId('clientsHeading').textContent, 'Clients', 'and back again');
  assert.equal(page.byId('rangeStart').textContent, 'All time');
});

// ── Usage over time ─────────────────────────────────────────

// A series the way GET /teamclaude/usage/series answers: 24 hourly buckets,
// oldest first, ending at `end`.
const HOUR = 3600_000;
const END = 1_000 * HOUR;
const hourly = (values) => { const a = new Array(24).fill(0); values.forEach(([i, v]) => { a[i] = v; }); return a; };
const SERIES = {
  slotMs: HOUR / 4, bucketMs: HOUR, buckets: 24, end: END,
  clients: {
    alice: { requests: hourly([[23, 2], [10, 1]]), inputTokens: hourly([[23, 100], [10, 50]]), outputTokens: hourly([[23, 20]]) },
    bob: { requests: hourly([[23, 5]]), inputTokens: hourly([[23, 10]]), outputTokens: hourly([[20, 30]]) },
    carol: { requests: hourly([[22, 1]]), inputTokens: hourly([[22, 7]]), outputTokens: hourly([]) },
    dave: { requests: hourly([[23, 1]]), inputTokens: hourly([[23, 3]]), outputTokens: hourly([]) },
  },
};

test('seriesLines totals every client an hour a point', () => {
  const lines = seriesLines(SERIES, '24h', 'tokens', null);
  assert.equal(lines.points.length, 24);
  const last = lines.points[23];
  assert.equal(last.total, 120 + 10 + 3);
  assert.equal(last.end, END);
  assert.equal(last.start, END - HOUR);
  assert.equal(lines.points[0].start, END - 24 * HOUR);
  assert.equal(lines.peak, 133);
  assert.equal(lines.peakAt, 23, 'the busiest hour overall');
  assert.equal(lines.total, 120 + 50 + 10 + 30 + 7 + 3);
  assert.equal(lines.last, 133, 'the newest hour, everyone in it');
  assert.equal(lines.spanMs, 24 * HOUR);
  assert.deepEqual(lines.lines, [], 'no names asked for, no per-client lines');
});

test('seriesLines draws a line per named client and folds the rest', () => {
  const lines = seriesLines(SERIES, '24h', 'tokens', ['alice', 'bob']);
  assert.deepEqual(lines.lines.map(l => l.name), ['alice', 'bob', 'others']);
  assert.deepEqual(lines.lines[2].members, ['carol', 'dave']);
  assert.equal(lines.lines[0].values[23], 120);
  assert.equal(lines.lines[0].values[10], 50);
  assert.equal(lines.lines[1].values[20], 30);
  assert.equal(lines.lines[2].values[22], 7);
  assert.equal(lines.lines[2].values[23], 3);
  assert.equal(lines.linePeak, 120);
  // A named client with nothing in the day still gets its (flat) line, so the
  // legend never names someone the chart leaves out.
  const quiet = seriesLines(SERIES, '24h', 'tokens', ['zed']);
  assert.deepEqual(quiet.lines[0].values, new Array(24).fill(0));
  assert.deepEqual(quiet.lines[1].members, ['alice', 'bob', 'carol', 'dave']);
  // Everyone named: no fold to draw.
  assert.equal(seriesLines(SERIES, '24h', 'tokens', ['alice', 'bob', 'carol', 'dave']).lines.length, 4);
});

test('seriesLines shows the last five hours for 5h, and Total as the whole day', () => {
  const five = seriesLines(SERIES, '5h', 'tokens', null);
  assert.equal(five.points.length, 5);
  assert.equal(five.points[0].start, END - 5 * HOUR);
  // alice's bucket 10 is outside the five hours, so it does not count toward the span.
  assert.equal(five.total, 120 + 10 + 30 + 7 + 3);
  assert.equal(seriesLines(SERIES, 'total', 'tokens', null).points.length, 24);
  // Nor does a fold whose members spent nothing inside the span.
  assert.deepEqual(seriesLines(SERIES, '5h', 'tokens', ['alice', 'bob', 'carol', 'dave']).lines.map(l => l.name), ['alice', 'bob', 'carol', 'dave']);
});

test('seriesLines draws one side of the tokens when asked', () => {
  const input = seriesLines(SERIES, '24h', 'input', ['alice']);
  assert.equal(input.points[23].total, 100 + 10 + 3);
  assert.equal(input.lines[0].values[23], 100);
  assert.equal(input.total, 100 + 50 + 10 + 7 + 3);
  const output = seriesLines(SERIES, '24h', 'output', ['alice']);
  assert.equal(output.points[23].total, 20);
  assert.equal(output.peak, 30, "bob's hour");
  assert.equal(output.total, 20 + 30);
  // The sides add up to the whole.
  assert.equal(input.total + output.total, seriesLines(SERIES, '24h', 'tokens', null).total);
});

test('seriesLines sums by requests when asked', () => {
  const lines = seriesLines(SERIES, '24h', 'requests', ['bob']);
  assert.equal(lines.points[23].total, 2 + 5 + 1);
  assert.equal(lines.lines[0].values[23], 5);
  assert.equal(lines.total, 2 + 1 + 5 + 1 + 1);
});

test('seriesLines tolerates nothing to draw', () => {
  for (const series of [null, {}, { buckets: 0, clients: {} }]) {
    const lines = seriesLines(series, '24h', 'tokens', null);
    assert.deepEqual(lines.points, []);
    assert.equal(lines.total, 0);
    assert.equal(lines.peakAt, -1);
    assert.equal(lines.last, 0);
  }
  const quiet = seriesLines({ ...SERIES, clients: { alice: { requests: hourly([]), inputTokens: hourly([]), outputTokens: hourly([]) } } }, '24h', 'tokens', null);
  assert.equal(quiet.points.length, 24, 'a quiet day still has its hours');
  assert.equal(quiet.peakAt, -1, 'and marks none of them');
});

test('userLineNames gives up to eight clients a line each, and more the busiest eight', () => {
  const rank = n => Array.from({ length: n }, (_, i) => ({ name: 'c' + i }));
  assert.deepEqual(userLineNames(rank(6)), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  assert.deepEqual(userLineNames(rank(8)).length, 8);
  assert.deepEqual(userLineNames(rank(11)), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
  assert.deepEqual(userLineNames(null), []);
});

test('userSlots colours a client by its name, not its rank', () => {
  assert.deepEqual(userSlots(['carol', 'alice', 'bob']), { alice: 0, bob: 1, carol: 2 });
  assert.deepEqual(userSlots(['bob', 'carol', 'alice']), userSlots(['carol', 'alice', 'bob']), 'a reordered ranking keeps the colours');
  assert.deepEqual(userSlots(null), {});
});

test('smoothPath passes through every point and never dips below the floor', () => {
  const d = smoothPath([[0, 165], [100, 15], [200, 165], [300, 165]], 165);
  assert.match(d, /^M0,165 C/);
  // Each segment ends on the next point.
  assert.deepEqual(d.match(/ (\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?= C|$)/g).map(x => x.trim()), ['100,15', '200,165', '300,165']);
  const ys = [...d.matchAll(/,(-?\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
  assert.ok(ys.every(y => y <= 165), 'no control point below the baseline');
  assert.equal(smoothPath([]), '');
  assert.equal(smoothPath([[5, 5]]), 'M5,5');
});

test('clientGroups gives the two busiest a column each and folds the rest', () => {
  const ranking = [
    { name: 'a', value: 600 }, { name: 'b', value: 200 }, { name: 'c', value: 100 },
    { name: 'd', value: 100 }, { name: 'idle', value: 0 },
  ];
  const g = clientGroups(ranking);
  assert.deepEqual(g.groups.map(x => [x.name, x.value]), [['a', 600], ['b', 200], ['others', 200]]);
  assert.deepEqual(g.groups[2].members, ['c', 'd']);
  assert.equal(g.groups[2].others, true);
  assert.equal(g.total, 1000);
  assert.equal(g.groups[0].share, 0.6);
  assert.equal(g.groups[0].lift, 1);
  assert.equal(g.groups[1].lift, 200 / 600);
  assert.ok(g.groups[0].grow > g.groups[1].grow, 'a bigger share, a wider column');
  // The idle client neither takes a column nor pulls the average down.
  assert.equal(g.clients, 4);
  assert.equal(g.average, 250);
  assert.equal(g.averageLift, 250 / 600);
});

test('clientGroups never folds a single client', () => {
  // Three clients are three columns: an "others" of one would only hide a name.
  const three = clientGroups([{ name: 'a', value: 3 }, { name: 'b', value: 2 }, { name: 'c', value: 1 }]);
  assert.deepEqual(three.groups.map(x => x.name), ['a', 'b', 'c']);
  assert.ok(three.groups.every(x => !x.others));
  const none = clientGroups([{ name: 'a', value: 0 }]);
  assert.deepEqual(none.groups, []);
  assert.equal(none.average, 0);
  assert.equal(none.averageLift, 0);
  assert.deepEqual(clientGroups(null).groups, []);
});

test('heatGrid lays clients against four-hour stretches of the day', () => {
  const g = heatGrid(SERIES, '24h', 'tokens');
  assert.equal(g.columns.length, 6);
  assert.deepEqual(g.columns[0], { start: END - 24 * HOUR, end: END - 20 * HOUR });
  assert.deepEqual(g.columns[5], { start: END - 4 * HOUR, end: END });
  assert.deepEqual(g.rows.map(r => r.name), ['alice', 'bob', 'carol', 'dave'], 'busiest first');
  // alice: 50 in bucket 10 (column 2), 120 in bucket 23 (column 5).
  assert.deepEqual(g.rows[0].cells.map(c => c.value), [0, 0, 50, 0, 0, 120]);
  assert.equal(g.max, 120);
  // Shades by quarters of the root of the share of the busiest cell (50/120
  // is 0.65 of the way up); nothing is 0, the faintest filled cell 1.
  assert.deepEqual(g.rows[0].cells.map(c => c.level), [0, 0, 3, 0, 0, 4]);
  // bob's 40 in the last stretch is a third of alice's 120: a linear scale
  // would shade it 2, the root lifts it clear of the faint end.
  assert.equal(g.rows[1].cells[5].value, 40);
  assert.equal(g.rows[1].cells[5].level, 3);
  assert.equal(g.rows[3].cells[5].level, 1, 'dave\'s 3 tokens are faint, not empty');
  // Every cell carries its two sides, for the tooltip, whatever the measure.
  assert.deepEqual([g.rows[0].cells[5].input, g.rows[0].cells[5].output], [100, 20]);
  assert.deepEqual([g.rows[1].cells[5].input, g.rows[1].cells[5].output], [10, 30]);
  const byRequests = heatGrid(SERIES, '24h', 'requests');
  assert.deepEqual([byRequests.rows[0].cells[5].input, byRequests.rows[0].cells[5].output], [10, 30], 'bob leads by requests; his sides still ride along');
});

test('heatGrid gives five hours a column each, and every active client a row of its own', () => {
  const five = heatGrid(SERIES, '5h', 'requests');
  assert.equal(five.columns.length, 5);
  assert.deepEqual(five.columns[4], { start: END - HOUR, end: END });
  assert.deepEqual(five.rows.map(r => r.name), ['bob', 'alice', 'carol', 'dave']);
  const clients = {};
  for (let i = 0; i < 9; i++) clients['c' + i] = { requests: hourly([[23, 10 - i]]), inputTokens: hourly([]), outputTokens: hourly([]) };
  clients.idle = { requests: hourly([]), inputTokens: hourly([]), outputTokens: hourly([]) };
  const many = heatGrid({ ...SERIES, clients }, '24h', 'requests');
  assert.deepEqual(many.rows.map(r => r.name), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'], 'nine rows, and none for the idle one');
  assert.ok(many.rows.every(r => !r.others));
  assert.equal(many.rows[8].cells[5].value, 2);
  assert.deepEqual(heatGrid(null, '24h', 'tokens').rows, []);
});

test('seriesTicks are the instants the axis labels with the clock, ending at the series end', () => {
  assert.deepEqual(seriesTicks(24 * HOUR, END), [END - 24 * HOUR, END - 18 * HOUR, END - 12 * HOUR, END - 6 * HOUR, END]);
  assert.deepEqual(seriesTicks(5 * HOUR, END), [5, 4, 3, 2, 1, 0].map(h => END - h * HOUR));
  assert.deepEqual(seriesTicks(0, END), []);
});

test('meterTone bands a meter on the legend\'s thresholds', () => {
  assert.equal(meterTone(0), 'ok');
  assert.equal(meterTone(0.59), 'ok');
  assert.equal(meterTone(0.6), 'warn');
  assert.equal(meterTone(0.89), 'warn');
  assert.equal(meterTone(0.9), 'bad');
  assert.equal(meterTone(1.2), 'bad');
  assert.equal(meterTone(null), 'ok');
});

test('the chart helpers run inside the serialized bundle', () => {
  const script = inlineScripts(renderDashboardHtml()).at(-1);
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return { clientGroups, seriesLines, userLineNames, userSlots, smoothPath, heatGrid, seriesTicks, meterTone };`)();
  assert.deepEqual(isolated.seriesLines(SERIES, '5h', 'requests', ['alice']), seriesLines(SERIES, '5h', 'requests', ['alice']));
  assert.deepEqual(isolated.userLineNames([{ name: 'a' }]), ['a']);
  assert.deepEqual(isolated.heatGrid(SERIES, '24h', 'tokens'), heatGrid(SERIES, '24h', 'tokens'));
  assert.deepEqual(isolated.clientGroups([{ name: 'a', value: 2 }]), clientGroups([{ name: 'a', value: 2 }]));
  assert.equal(isolated.smoothPath([[0, 1], [2, 3]], 5), smoothPath([[0, 1], [2, 3]], 5));
  assert.deepEqual(isolated.seriesTicks(24 * HOUR, END), seriesTicks(24 * HOUR, END));
  assert.deepEqual(isolated.userSlots(['b', 'a']), { a: 0, b: 1 });
  assert.equal(isolated.meterTone(0.7), 'warn');
});

test('a status with a client fetches the usage series and draws it', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], clients: { alice: { requests: 3, inputTokens: 150, outputTokens: 20 } } });
  const req = page.requests.find(r => r.url === '/teamclaude/usage/series');
  assert.ok(req, 'the charts ask for their history');
  assert.equal(req.init.headers['x-api-key'], '', 'with the same key as the status poll');
  assert.equal(page.byId('seriesWrap').style.display, '');
  assert.equal(page.byId('heatWrap').style.display, '');
  assert.equal(page.byId('seriesEmpty').textContent, 'Loading usage history…', 'nothing to draw before the history lands');
  assert.equal(page.byId('heroDelta').style.display, 'none');
  await page.answerSeries(SERIES);
  assert.equal(page.byId('seriesEmpty').style.display, 'none');
  assert.equal(page.byId('seriesCaption').textContent, 'Tokens / hour · last 24h');
  // Tokens are two panels, each marking its own busiest hour, every client in it.
  assert.equal(page.byId('peakMain').textContent, 'Peak 113 tok', 'input: alice 100, bob 10, dave 3 in the last hour');
  assert.equal(page.byId('peakOut').textContent, 'Peak 30 tok', "output: bob's 30 three hours earlier");
  assert.equal(page.byId('seriesOutPlot').style.display, '');
  assert.equal(page.byId('seriesInMax').textContent, 'scale to 130 tok', 'each panel names its own scale');
  assert.equal(page.byId('heroDelta').textContent, '+133 last hour', 'the delta is still both sides');
  assert.equal(page.byId('heatTitle').textContent, 'Tokens by time');
  page.click('Last 5h');
  assert.equal(page.byId('seriesCaption').textContent, 'Tokens / hour · last 5h', 'the window control redraws it');
  assert.equal(page.labelled('-5h'), 0, 'the axis reads the clock, not hours ago');
  page.click('Requests');
  assert.equal(page.byId('peakMain').textContent, 'Peak 8 req');
  assert.equal(page.byId('seriesOutPlot').style.display, 'none', 'requests are one panel');
  assert.equal(page.byId('seriesInHead').style.display, 'none');
  assert.equal(page.byId('heatTitle').textContent, 'Tokens by time', 'the grid follows Usage by user, not the overview');
  page.clickNth('Requests', 1);
  assert.equal(page.byId('heatTitle').textContent, 'Requests by time');
  assert.equal(page.pending().length, 0, 'redrawn from the fetched series, not re-fetched');
});

test('Usage by user ranks every client and draws their lines in the same colours', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], clients: {
    alice: { requests: 3, inputTokens: 150, outputTokens: 20 },
    bob: { requests: 6, inputTokens: 10, outputTokens: 30 },
  } });
  assert.equal(page.byId('usersSec').style.display, '');
  // alice's row, agreeing with her overview column while both are on Total.
  assert.equal(page.labelled('170 tok'), 2);
  assert.equal(page.labelled(' · 81%'), 1, 'and her share');
  assert.equal(page.labelled('150 in · 20 out'), 1, 'and the two sides of it');
  assert.equal(page.byId('userEmpty').textContent, 'Loading usage history…');
  await page.answerSeries(SERIES);
  assert.equal(page.byId('userEmpty').style.display, 'none');
  assert.equal(page.byId('userCaption').textContent, 'Tokens / hour · last 24h');
  // Two clients ranked, two lines, and the rest of the series (carol, dave)
  // folded into a third the legend names by count.
  assert.equal(page.labelled('2 others'), 1);
  // The axis ends on the series' own end, by the clock.
  const clock = new Date(END).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  assert.ok(page.labelled(clock) >= 1, 'the last tick is the end of the series');
  // Each panel's scale tops out a little over its highest line: alice's 100
  // input, and bob's 30 output, times 1.15.
  assert.equal(page.byId('userMax').textContent, '115 tok');
  assert.equal(page.byId('userOutMax').textContent, '35 tok');
  assert.equal(page.byId('userOutPlot').style.display, '');
});

test('Usage by user keeps its own window and measure', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], clients: {
    alice: { requests: 3, inputTokens: 150, outputTokens: 20 },
    bob: { requests: 6, inputTokens: 10, outputTokens: 30 },
  } });
  await page.answerSeries(SERIES);
  // The second Requests button is the section's: it changes the section only.
  page.clickNth('Requests', 1);
  assert.equal(page.labelled('6 req'), 1, "bob leads the section's ranking by requests");
  assert.equal(page.byId('userCaption').textContent, 'Requests / hour · last 24h');
  assert.equal(page.byId('heroLabel').textContent, 'Tokens used', 'the overview is left on tokens');
  page.clickNth('Last 5h', 1);
  assert.equal(page.byId('userCaption').textContent, 'Requests / hour · last 5h');
  assert.equal(page.byId('seriesCaption').textContent, 'Tokens / hour · last 24h', 'and on its own window');
  assert.equal(page.pending().length, 0, 'redrawn from what is held, not re-fetched');
});

test('a series that fails to load says so in the chart', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], clients: { alice: { requests: 1 } } });
  await page.answerSeries({}, 500);
  assert.equal(page.byId('seriesEmpty').textContent, 'Usage history unavailable: status 500');
  assert.equal(page.byId('userEmpty').textContent, 'Usage history unavailable: status 500');
  assert.equal(page.byId('heatEmpty').textContent, 'History unavailable');
});

test('no client, no chart and no series fetch', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [] });
  assert.equal(page.byId('seriesWrap').style.display, 'none');
  assert.equal(page.byId('heatWrap').style.display, 'none');
  assert.equal(page.byId('clientChartWrap').style.display, 'none');
  assert.equal(page.byId('usersSec').style.display, 'none');
  assert.equal(page.requests.some(r => r.url === '/teamclaude/usage/series'), false);
});

test('the page embeds its fonts, and the policy admits only those', () => {
  const html = renderDashboardHtml();
  assert.match(html, /@font-face \{ font-family: 'DM Sans'; src: url\(data:font\/woff2;base64,/);
  assert.match(html, /@font-face \{ font-family: 'DM Mono'; src: url\(data:font\/woff2;base64,/);
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
  assert.match(dashboardCsp(), /(^|; )font-src data:(;|$)/);
});
