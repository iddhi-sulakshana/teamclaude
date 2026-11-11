import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

// `accounts[].allowExtraUsage: "admin"`: a seat with paid overage on upstream
// that the operator keeps back for admins. Its free quota rotates like any
// account's; its extra usage is the last tier of the fallback, after every
// account opted in with `true`, and only an admin caller reaches it. A caller
// that is not an admin gets what an empty fleet gives today.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const OPUS = 'claude-opus-5';

function setQuota(account, q) {
  Object.assign(account.quota, q);
}

// Every account at 100% weekly and the probe slot spent, so selection reaches
// the fallback.
function spentFleet(accounts) {
  const am = new AccountManager(accounts, 0.98);
  for (const a of am.accounts) setQuota(a, { unified7d: 1.0 });
  am._nextProbeAt = Date.now() + 60_000;
  return am;
}

function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}

function captureLog(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = log; }
  return lines;
}

/** A selection as an admin caller makes it. */
function asAdmin(am, exclude = null, model = OPUS) {
  return am.getActiveAccount(exclude, model, null, null, undefined, null, true);
}

// ── who reaches it ───────────────────────────────────────────

test('with only a held seat left, an admin is served from its extra usage', () => {
  const am = spentFleet([oauth('a'), oauth('held', { allowExtraUsage: 'admin' })]);
  assert.equal(quietly(() => asAdmin(am))?.name, 'held');
  assert.equal(am.getStatus().accounts[1].onExtraUsage, true);
});

test('a caller that is not an admin gets nothing from a held seat', () => {
  const am = spentFleet([oauth('a'), oauth('held', { allowExtraUsage: 'admin' })]);
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS, null, null, undefined, null, false)), null);
  // Unspecified is not an admin: a caller that never says gets the safe answer.
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)), null);
  assert.equal(am.getStatus().accounts[1].onExtraUsage, false);
});

// ── order of the tiers ───────────────────────────────────────

test('accounts opted in for everyone bill before a held seat, for admins too', () => {
  const am = spentFleet([
    oauth('held', { allowExtraUsage: 'admin', priority: 0 }),
    oauth('paid', { allowExtraUsage: true, priority: 5 }),
  ]);
  // Priority would favour `held`; the tier decides first.
  assert.equal(quietly(() => asAdmin(am))?.name, 'paid');
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS))?.name, 'paid');
});

test('once the opted-in accounts can bill no more, admins move to the held seat', async (t) => {
  const cases = {
    'maxUsage cap': a => { a.maxUsage = 1.2; setQuota(a, { unified7d: 1.25 }); },
    'maxSpend cap': a => { a.maxSpend = 10; setQuota(a, { spend: { enabled: true, usedMinor: 1000, limitMinor: 5000, currency: 'USD', exponent: 2 } }); },
    'overage off upstream': a => { setQuota(a, { spend: { enabled: false } }); },
  };
  for (const [name, arm] of Object.entries(cases)) {
    await t.test(name, () => {
      const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true }), oauth('held', { allowExtraUsage: 'admin' })]);
      arm(am.accounts[1]);
      assert.equal(quietly(() => asAdmin(am))?.name, 'held');
      assert.equal(quietly(() => am.getActiveAccount(null, OPUS)), null);
    });
  }
});

test('free quota on a held seat is for everyone, and bills nobody', () => {
  const am = new AccountManager([oauth('a'), oauth('held', { allowExtraUsage: 'admin' })], 0.98);
  setQuota(am.accounts[0], { unified7d: 1.0 });
  setQuota(am.accounts[1], { unified7d: 0.99 });
  am._nextProbeAt = Date.now() + 60_000;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS))?.name, 'held');
  assert.equal(am.getStatus().accounts[1].onExtraUsage, false);
});

test('a held seat rotates normally while it has headroom', () => {
  const am = new AccountManager([oauth('held', { allowExtraUsage: 'admin' }), oauth('b')], 0.98);
  setQuota(am.accounts[0], { unified7d: 0.4 });
  setQuota(am.accounts[1], { unified7d: 0.5 });
  am.currentIndex = 0;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS))?.name, 'held');
});

test('hard gates still bind a held seat for admins', async (t) => {
  const cases = {
    disabled: a => { a.disabled = true; },
    'maxUsage cap': a => { a.maxUsage = 1.2; setQuota(a, { unified7d: 1.25 }); },
    'overage off upstream': a => { setQuota(a, { spend: { enabled: false } }); },
  };
  for (const [name, arm] of Object.entries(cases)) {
    await t.test(name, () => {
      const am = spentFleet([oauth('a'), oauth('held', { allowExtraUsage: 'admin' })]);
      arm(am.accounts[1]);
      assert.equal(quietly(() => asAdmin(am)), null);
    });
  }
});

// ── the episode is not ended by callers who cannot reach it ─

test('a request from a non-admin between admin ones does not end the held episode', () => {
  const am = spentFleet([oauth('a'), oauth('held', { allowExtraUsage: 'admin' })]);
  let ramp;
  const lines = captureLog(() => {
    for (let i = 0; i < 4; i++) {
      assert.equal(asAdmin(am)?.name, 'held');
      if (i === 0) ramp = am.accounts[1].rampStartedAt = 1;
      assert.equal(am.getActiveAccount(null, OPUS), null);
      assert.equal(am.getStatus().accounts[1].onExtraUsage, true);
    }
  });
  assert.equal(lines.filter(l => l.includes('on extra usage')).length, 1);
  assert.equal(lines.filter(l => l.includes('leaving extra usage')).length, 0);
  assert.equal(am.accounts[1].rampStartedAt, ramp);
});

test('the held episode still ends when some account has headroom again', () => {
  const am = spentFleet([oauth('a'), oauth('held', { allowExtraUsage: 'admin' })]);
  quietly(() => asAdmin(am));
  setQuota(am.accounts[0], { unified7d: 0.1 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS))?.name, 'a');
  assert.equal(am.getStatus().accounts[1].onExtraUsage, false);
});

// ── failover hops ────────────────────────────────────────────

test('a failover hop lands on a held seat for an admin only', () => {
  const am = spentFleet([oauth('a'), oauth('held', { allowExtraUsage: 'admin' })]);
  am.currentIndex = 0;
  assert.equal(quietly(() => am.pickAlternate(new Set([0]), OPUS)), null);
  assert.equal(quietly(() => am.pickAlternate(new Set([0]), OPUS, null, undefined, true))?.name, 'held');
  assert.equal(am.currentIndex, 0);
});

// ── the revalidation probe ───────────────────────────────────

// The probe sends a live request to a spent account. On a held seat whose
// overage is on upstream that request bills, so a non-admin's probe goes
// elsewhere.
test("a non-admin's probe skips a held seat that would bill", () => {
  const am = new AccountManager([
    oauth('a', { priority: 1 }),
    oauth('held', { allowExtraUsage: 'admin', priority: 0 }),
  ], 0.98);
  for (const a of am.accounts) setQuota(a, { unified7d: 1.0 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS))?.name, 'a');
});

test("a non-admin's probe has nowhere to go when only a held seat is left", () => {
  const am = new AccountManager([oauth('held', { allowExtraUsage: 'admin' })], 0.98);
  setQuota(am.accounts[0], { unified7d: 1.0 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)), null);
  am._nextProbeAt = 0;
  assert.equal(quietly(() => asAdmin(am))?.name, 'held');
});

// ── config ───────────────────────────────────────────────────

test('only the literal "admin" holds a seat back, on Anthropic OAuth accounts only', () => {
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  let am;
  try {
    am = new AccountManager([
      oauth('held', { allowExtraUsage: 'admin' }),
      oauth('typo', { allowExtraUsage: 'Admin' }),
      { name: 'key', type: 'apikey', apiKey: 'k', allowExtraUsage: 'admin' },
      oauth('codex', { provider: 'codex', allowExtraUsage: 'admin' }),
    ], 0.98);
  } finally {
    console.warn = original;
  }
  assert.deepEqual(am.accounts.map(a => a.allowExtraUsage), ['admin', false, false, false]);
  const ignored = warned.filter(l => l.includes('allowExtraUsage is ignored'));
  assert.deepEqual(ignored.map(l => /Account "([^"]+)"/.exec(l)?.[1]), ['key', 'codex']);
});

test('a config reload applies "admin" live and keeps it in the config entry', async () => {
  const config = [oauth('a'), oauth('held')];
  const am = spentFleet(config.map(c => ({ ...c })));
  assert.equal(quietly(() => asAdmin(am)), null);

  await quietly(() => syncAccountsFromDisk({ accounts: [oauth('a'), oauth('held', { allowExtraUsage: 'admin' })] }, { accounts: config }, am));
  assert.equal(am.accounts[1].allowExtraUsage, 'admin');
  assert.equal(config[1].allowExtraUsage, 'admin');
  assert.equal(quietly(() => asAdmin(am))?.name, 'held');
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)), null);

  await quietly(() => syncAccountsFromDisk({ accounts: [oauth('a'), oauth('held')] }, { accounts: config }, am));
  assert.equal(am.accounts[1].allowExtraUsage, false);
  assert.equal('allowExtraUsage' in config[1], false);
  assert.equal(quietly(() => asAdmin(am)), null);
});

// ── status and displays ──────────────────────────────────────

test('status names a held seat apart from one opted in for everyone', () => {
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true }), oauth('held', { allowExtraUsage: 'admin' })], 0.98);
  const rows = am.getStatus().accounts.map(a => [a.name, a.allowExtraUsage, a.extraUsageAdminOnly]);
  assert.deepEqual(rows, [['a', false, false], ['paid', true, false], ['held', false, true]]);
});

test('the status header says a held seat is for admins', async () => {
  const { renderStatus } = await import('../src/status-renderer.js');
  const am = new AccountManager([oauth('a'), oauth('held', { allowExtraUsage: 'admin' })], 0.98);
  const lines = renderStatus(am.getStatus(), { color: false }).split('\n');
  assert.ok(lines.some(l => l.includes('held') && l.includes('extra usage for admins')), lines.join('\n'));
  assert.ok(!lines.some(l => l.includes('held') && l.includes('extra usage allowed')), lines.join('\n'));
});

test('dashboard badge: for admins, then billing', async () => {
  const { accountBadges } = await import('../src/dashboard.js');
  const texts = acct => accountBadges(acct, 'x', null).filter(b => b.cls.startsWith('extra-usage'));
  assert.deepEqual(texts({ name: 'p', extraUsageAdminOnly: true }), [{ cls: 'extra-usage', text: 'extra usage for admins' }]);
  assert.deepEqual(texts({ name: 'p', extraUsageAdminOnly: true, onExtraUsage: true }),
    [{ cls: 'extra-usage billing', text: 'on extra usage — billing' }]);
});

test('TUI row tag: xuA for a held seat, xu! while billing, same in attach mode', async () => {
  const { extraUsageTag } = await import('../src/tui.js');
  const { RemoteAccountManager } = await import('../src/tui-remote.js');
  assert.equal(extraUsageTag(false, false, true), 'xuA');
  assert.equal(extraUsageTag(false, true, true), 'xu!');
  assert.equal(extraUsageTag(true, false, false), 'xu');

  const am = new AccountManager([oauth('a'), oauth('held', { allowExtraUsage: 'admin' })], 0.98);
  const remote = new RemoteAccountManager();
  remote.applyStatus(JSON.parse(JSON.stringify(am.getStatus())));
  assert.equal(remote.accounts[1].extraUsageAdminOnly, true);
  // The local account's shape, so the TUI draws `xuA` attached as it does locally.
  assert.equal(remote.accounts[1].allowExtraUsage, 'admin');
  assert.equal(remote.accounts[0].extraUsageAdminOnly, false);
  assert.equal(remote.accounts[0].allowExtraUsage, false);
  remote.applyStatus({ accounts: [{ name: 'x', extraUsageAdminOnly: 'yes' }] });
  assert.equal(remote.accounts[0].extraUsageAdminOnly, false);
  assert.equal(remote.accounts[0].allowExtraUsage, false);
});

// ── through the server ───────────────────────────────────────

const CLIENT_KEYS = [
  { name: 'dev', key: 'tc-dev' },
  { name: 'boss', key: 'tc-boss', role: 'admin' },
];

async function withProxy(fn) {
  const { createProxyServer } = await import('../src/server.js');
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(String(req.headers.authorization || '').replace('Bearer t-', ''));
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message","content":[]}');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const am = spentFleet([oauth('a'), oauth('held', { allowExtraUsage: 'admin' })]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k', clientKeys: CLIENT_KEYS },
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const send = async (key, path = '/v1/messages') => {
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model: OPUS, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    return res.status;
  };
  const log = console.log;
  console.log = () => {};
  try {
    return await fn({ send, seen });
  } finally {
    console.log = log;
    proxy.close();
    proxy.closeAllConnections?.();
    upstream.close();
    upstream.closeAllConnections?.();
  }
}

test('server: an admin key is served by the held seat, a tenant key is refused', async () => {
  await withProxy(async ({ send, seen }) => {
    assert.equal(await send('tc-dev'), 429);
    assert.deepEqual(seen, []);
    assert.equal(await send('tc-boss'), 200);
    assert.deepEqual(seen, ['held']);
    // The shared key is the operator, an admin too.
    assert.equal(await send('k'), 200);
    assert.deepEqual(seen, ['held', 'held']);
    assert.equal(await send('tc-dev'), 429);
    assert.deepEqual(seen, ['held', 'held']);
  });
});

test('server: a pin does not let a tenant spend a held seat', async () => {
  await withProxy(async ({ send, seen }) => {
    assert.equal(await send('tc-dev', '/tc-acct/held/v1/messages'), 429);
    assert.deepEqual(seen, []);
    assert.equal(await send('tc-boss', '/tc-acct/held/v1/messages'), 200);
    assert.deepEqual(seen, ['held']);
  });
});
