import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addClientKey,
  ConfigOpError,
  MAX_PROBE_SECONDS,
  removeClientKey,
  resolveConfiguredAccount,
  rotateClientKey,
  setAccountDisabled,
  setAccountPriority,
  removeRoute,
  setBlockedModels,
  setBucketThresholds,
  setClientKeyRole,
  setDefaultClientMode,
  setDistribution,
  setProbeSeconds,
  setThreshold,
  setWarmupSchedule,
  setWarmupSeconds,
  thresholdRatio,
  thresholdTable,
  upsertRoute,
} from '../src/config-ops.js';

const refused = (fn, pattern) => assert.throws(fn, err => err instanceof ConfigOpError && pattern.test(err.message));

test('the probe interval is off, or between the floor and the ceiling', () => {
  const config = {};
  setProbeSeconds(config, 300);
  assert.equal(config.quotaProbeSeconds, 300);
  setProbeSeconds(config, 0);
  assert.equal(config.quotaProbeSeconds, 0);
  setProbeSeconds(config, MAX_PROBE_SECONDS);
  assert.equal(config.quotaProbeSeconds, MAX_PROBE_SECONDS);

  refused(() => setProbeSeconds(config, 29), /Minimum probe interval is 30s/);
  refused(() => setProbeSeconds(config, MAX_PROBE_SECONDS + 1), /Maximum probe interval/);
  refused(() => setProbeSeconds(config, -1), /whole number of seconds/);
  refused(() => setProbeSeconds(config, 1.5), /whole number of seconds/);
  assert.equal(config.quotaProbeSeconds, MAX_PROBE_SECONDS, 'a refused value must not be stored');
});

test('an interval keep-warm replaces a schedule, and the floor is a minute', () => {
  const config = { warmupSchedule: { resetTime: '15:30', timezone: 'Europe/Moscow' } };
  setWarmupSeconds(config, 120);
  assert.equal(config.warmupSeconds, 120);
  assert.equal('warmupSchedule' in config, false);

  refused(() => setWarmupSeconds(config, 59), /Minimum keep-warm interval is 60s/);
  refused(() => setWarmupSeconds(config, -5), /whole number of seconds/);
  assert.equal(config.warmupSeconds, 120);
});

test('a reset schedule stores the normalized target and switches the interval off', () => {
  const config = { warmupSeconds: 300 };
  setWarmupSchedule(config, 'reset', { resetTime: '15:30', timezone: 'Europe/Moscow' });
  assert.deepEqual(config.warmupSchedule, { resetTime: '15:30', timezone: 'Europe/Moscow' });
  assert.equal(config.warmupSeconds, 0);
});

test('a rolling schedule carries its anchor', () => {
  const config = {};
  setWarmupSchedule(config, 'rolling', { resetTime: '15:30', timezone: 'Europe/Moscow' });
  assert.equal(config.warmupSchedule.mode, 'rolling');
  assert.ok(Number.isFinite(Date.parse(config.warmupSchedule.anchorResetAt)));
});

test('a schedule the resolver rejects is refused and leaves the config alone', () => {
  const config = { warmupSeconds: 300 };
  refused(() => setWarmupSchedule(config, 'reset', { resetTime: '15:30', timezone: 'Not/AZone' }), /invalid IANA timezone/);
  refused(() => setWarmupSchedule(config, 'reset', { resetTime: '25:00', timezone: 'Europe/Moscow' }), /HH:MM/);
  refused(() => setWarmupSchedule(config, 'weekly', { resetTime: '15:30', timezone: 'Europe/Moscow' }), /reset or rolling/);
  assert.deepEqual(config, { warmupSeconds: 300 });
});

test('a percentage is stored as a ratio quantised to tenths of a percent', () => {
  assert.equal(thresholdRatio(90), 0.9);
  assert.equal(thresholdRatio('97.25'), 0.973);
  assert.equal(thresholdRatio(0), null);
  assert.equal(thresholdRatio(101), null);
  assert.equal(thresholdRatio('ninety'), null);
  assert.equal(thresholdRatio(null), null);
  assert.equal(thresholdRatio(''), null);
  assert.equal(thresholdRatio(' '), null);
  // Number() would make 1 of `true` and 95 of `[95]`: a caller that is a model,
  // not a person typing, sends exactly such things.
  for (const notANumber of [true, false, [95], {}, undefined]) {
    assert.equal(thresholdRatio(notANumber), null, JSON.stringify(notANumber));
  }
});

test('one threshold replaces a per-bucket table and names what it dropped', () => {
  const config = { switchThreshold: { default: 0.98, unified7d: 0.9 } };
  assert.deepEqual(setThreshold(config, 85), { dropped: ['unified7d'] });
  assert.equal(config.switchThreshold, 0.85);
  assert.deepEqual(setThreshold(config, 80), { dropped: [] });

  refused(() => setThreshold(config, 0), /percentage from 1 to 100/);
  assert.equal(config.switchThreshold, 0.8);
});

test('bucket thresholds build a table that collapses once the last override goes', () => {
  const config = { switchThreshold: 0.95 };
  setBucketThresholds(config, [['unified7d', 90], ['default', 97]]);
  assert.deepEqual(config.switchThreshold, { default: 0.97, unified7d: 0.9 });

  setBucketThresholds(config, [['unified7d', null]]);
  assert.equal(config.switchThreshold, 0.97);
});

test('a bucket threshold is refused as a whole when any pair is bad', () => {
  const config = { switchThreshold: 0.95 };
  refused(() => setBucketThresholds(config, [['unified7d', 90], ['weekly', 80]]), /Unknown quota bucket "weekly"/);
  refused(() => setBucketThresholds(config, [['default', null]]), /default threshold is the fallback/);
  refused(() => setBucketThresholds(config, [['unified7d', 500]]), /percentage from 1 to 100/);
  refused(() => setBucketThresholds(config, [['unified7d', true]]), /percentage from 1 to 100/);
  refused(() => setBucketThresholds(config, [['unified7d', [95]]]), /percentage from 1 to 100/);
  assert.equal(config.switchThreshold, 0.95);
});

test('distribution stores what the router reads and reports whether it changed', () => {
  const config = {};
  assert.equal(setDistribution(config, 'adaptive'), true);
  assert.equal(config.distributeSessions, 'adaptive');
  assert.equal(setDistribution(config, 'adaptive'), false);
  assert.equal(setDistribution(config, 'even'), true);
  assert.equal(config.distributeSessions, true);
  assert.equal(setDistribution(config, 'off'), true);
  assert.equal(config.distributeSessions, false);

  refused(() => setDistribution(config, 'sometimes'), /off, even or adaptive/);
});

test('a route is added, then replaced in place under the same name', () => {
  const config = { accounts: [{ name: 'a' }] };
  const first = { name: 'opus', match: ['claude-opus-*'], accounts: ['a'], color: 'red' };
  assert.deepEqual(upsertRoute(config, { name: ' opus ', match: ['claude-opus-*'], accounts: ['a'], color: 'RED' }), { route: first, updated: false, unknownAccounts: [] });
  assert.deepEqual(config.routes, [first]);

  const second = { name: 'opus', match: ['claude-opus-5'], accounts: ['ghost', '2'], bucket: 'unified7d' };
  assert.deepEqual(upsertRoute(config, { name: 'opus', match: ['claude-opus-5'], accounts: ['ghost', '2'], bucket: 'unified7d' }), { route: second, updated: true, unknownAccounts: ['ghost'] });
  assert.deepEqual(config.routes, [{ name: 'opus', match: ['claude-opus-5'], accounts: ['ghost', '2'], bucket: 'unified7d' }]);
});

test('a route needs a name, a match and a known color', () => {
  const config = { accounts: [] };
  refused(() => upsertRoute(config, { name: '', match: ['x'] }), /needs a name and at least one match/);
  refused(() => upsertRoute(config, { name: 'r', match: [] }), /needs a name and at least one match/);
  refused(() => upsertRoute(config, { name: 'r', match: ['x'], color: 'notacolor' }), /Unknown color "notacolor"/);
  assert.equal(config.routes, undefined);
});

// These strings are drawn on the operator's terminal as stored — the TUI prints
// a route's name raw — so an escape sequence in one is a way to repaint it.
test('a control character is refused in every string a route or the blocklist stores', () => {
  const config = { accounts: [], blockedModels: ['kept'] };
  const ok = { name: 'r', match: ['claude-*'] };
  // ESC, a bare newline, DEL, and the 8-bit CSI that needs no ESC in front.
  for (const bad of ['\x1b[2J', 'a\nb', 'a\x7f', '\x9b31m', 'trailing\n']) {
    refused(() => upsertRoute(config, { ...ok, name: `opus${bad}` }), /route name must not contain control characters/);
    refused(() => upsertRoute(config, { ...ok, match: ['fine', `x${bad}`] }), /route match glob must not contain control characters/);
    refused(() => upsertRoute(config, { ...ok, accounts: [`a${bad}`] }), /route account must not contain control characters/);
    refused(() => upsertRoute(config, { ...ok, bucket: `unified7d${bad}` }), /route bucket must not contain control characters/);
    refused(() => setBlockedModels(config, ['fine', `gpt-${bad}`]), /blocked-model pattern must not contain control characters/);
  }
  assert.equal(config.routes, undefined, 'a refused route must not be stored');
  assert.deepEqual(config.blockedModels, ['kept'], 'a refused blocklist must not be stored');

  // Printable text outside ASCII is not a control character.
  upsertRoute(config, { name: 'opus — équipe', match: ['claude-opus-*'] });
  assert.equal(config.routes[0].name, 'opus — équipe');
});

test('removing a route that is not there is refused', () => {
  const config = { routes: [{ name: 'opus', match: ['x'] }] };
  refused(() => removeRoute(config, 'sonnet'), /Route "sonnet" not found/);
  removeRoute(config, 'opus');
  assert.deepEqual(config.routes, []);
});

test('the model blocklist is replaced as a whole, trimmed and deduplicated', () => {
  const config = { blockedModels: ['old'] };
  setBlockedModels(config, [' claude-opus-* ', 'claude-opus-*', 'gpt-*']);
  assert.deepEqual(config.blockedModels, ['claude-opus-*', 'gpt-*']);
  setBlockedModels(config, []);
  assert.deepEqual(config.blockedModels, []);

  refused(() => setBlockedModels(config, ['ok', '']), /non-empty string/);
  refused(() => setBlockedModels(config, 'claude-*'), /list of model patterns/);
});

test('the default client mode is one of the two the launcher understands', () => {
  const config = {};
  setDefaultClientMode(config, 'base-url');
  assert.equal(config.defaultClientMode, 'base-url');
  setDefaultClientMode(config, 'mitm');
  assert.equal(config.defaultClientMode, 'mitm');
  refused(() => setDefaultClientMode(config, 'socks'), /mitm or base-url/);
});

// A route's `bucket` is stored verbatim and becomes its weekly gating key, so a
// typo named a bucket no account carries and the route was silently never
// weekly-gated (#424).
test('an unknown route bucket is refused, with the valid ones named', () => {
  const config = { routes: [], accounts: [] };
  assert.throws(
    () => upsertRoute(config, { name: 'opus', match: ['claude-opus-*'], bucket: 'unified7dFabel' }),
    (err) => err instanceof ConfigOpError && /Unknown route bucket "unified7dFabel"/.test(err.message) && /unified7dFable/.test(err.message),
  );
  assert.deepEqual(config.routes, [], 'a refused route writes nothing');
  assert.equal(upsertRoute(config, { name: 'opus', match: ['claude-opus-*'], bucket: 'unified7dFable' }).route.bucket, 'unified7dFable');
});

// Only a hand edit produces an array. Spread into the table it became a bucket
// named "0" that nothing asks about (#425).
test('an array switchThreshold is the default table, not numeric bucket keys', () => {
  const origError = console.error;
  const said = [];
  console.error = (...a) => said.push(a.join(' '));
  try {
    assert.deepEqual(thresholdTable([0.9]), { default: 0.98 });
  } finally {
    console.error = origError;
  }
  assert.equal(said.length, 1);
  assert.match(said[0], /switchThreshold is an array/);
});

const acctConfig = () => ({ accounts: [
  { name: 'a@x.com (Acme)', accountUuid: 'u-1', orgName: 'Acme', priority: 0 },
  { name: 'a@x.com (Beta)', accountUuid: 'u-1', orgName: 'Beta', priority: 3 },
  { name: 'solo@x.com', accountUuid: 'u-2', priority: 7 },
] });

test('resolveConfiguredAccount refuses an ambiguous name rather than picking one', () => {
  const config = acctConfig();
  // The same email in two orgs is two different accounts; taking the first
  // would disable or reprioritize the wrong one.
  assert.throws(() => resolveConfiguredAccount(config, 'a@x.com'), ConfigOpError);
  try {
    resolveConfiguredAccount(config, 'a@x.com');
  } catch (err) {
    assert.match(err.message, /matches 2 accounts/);
    assert.match(err.message, /Acme/);
    assert.match(err.message, /Beta/);
  }
  assert.equal(resolveConfiguredAccount(config, 'a@x.com', 'Acme').orgName, 'Acme');
  assert.equal(resolveConfiguredAccount(config, 'solo@x.com').name, 'solo@x.com');
  assert.throws(() => resolveConfiguredAccount(config, 'nobody@x.com'), ConfigOpError);
  assert.throws(() => resolveConfiguredAccount(config, '  '), ConfigOpError);
});

test('setAccountPriority places relative to the rest, or takes an exact number', () => {
  const config = acctConfig();
  // 'first' is one below the lowest, counting 0 even when nothing sits there.
  assert.deepEqual(setAccountPriority(config, 'solo@x.com', { place: 'first' }),
    { name: 'solo@x.com', priority: -1 });
  assert.deepEqual(setAccountPriority(config, 'solo@x.com', { place: 'last' }),
    { name: 'solo@x.com', priority: 4 });
  assert.deepEqual(setAccountPriority(config, 'solo@x.com', { priority: 2 }),
    { name: 'solo@x.com', priority: 2 });
  // Zero is a real priority, not a missing one.
  assert.deepEqual(setAccountPriority(config, 'solo@x.com', { priority: 0 }),
    { name: 'solo@x.com', priority: 0 });
  assert.throws(() => setAccountPriority(config, 'solo@x.com', { priority: 1.5 }), ConfigOpError);
  assert.throws(() => setAccountPriority(config, 'solo@x.com', {}), ConfigOpError);
  assert.throws(() => setAccountPriority(config, 'a@x.com', { place: 'first' }), ConfigOpError);
});

test('setAccountDisabled deletes the key when enabling, as the CLI always has', () => {
  const config = acctConfig();
  assert.deepEqual(setAccountDisabled(config, 'solo@x.com', true), { name: 'solo@x.com', disabled: true });
  assert.equal(config.accounts[2].disabled, true);
  assert.deepEqual(setAccountDisabled(config, 'solo@x.com', false), { name: 'solo@x.com', disabled: false });
  assert.ok(!('disabled' in config.accounts[2]), 'enabling removes the key rather than writing false');
  // A throwing op must not have half-applied.
  assert.throws(() => setAccountDisabled(config, 'solo@x.com', 'yes'), ConfigOpError);
  assert.ok(!('disabled' in config.accounts[2]));
});

// ── users (proxy.clientKeys) ─────────────────────────────────────────────────

const userConfig = () => ({
  proxy: {
    apiKey: 'tc-shared',
    clientKeys: [
      { name: 'alice', key: 'tc-alice', role: 'admin' },
      { name: 'bob', key: 'tc-bob' },
      // A name listed twice shares one usage counter; the ops treat it as one user.
      { name: 'ci', key: 'tc-ci-1', role: 'readonly' },
      { name: 'ci', key: 'tc-ci-2', role: 'readonly' },
    ],
  },
});

test('addClientKey generates the key, stores the role, and leaves a tenant without one', () => {
  const config = userConfig();
  const carol = addClientKey(config, { name: '  carol ', role: 'readonly' });
  assert.equal(carol.name, 'carol', 'the name is trimmed');
  assert.equal(carol.role, 'readonly');
  assert.match(carol.key, /^tc-[A-Za-z0-9_-]{32}$/, 'the same shape as the generated proxy.apiKey');
  assert.deepEqual(config.proxy.clientKeys.at(-1), { name: 'carol', key: carol.key, role: 'readonly' });

  const dave = addClientKey(config, { name: 'dave', role: 'tenant' });
  assert.equal(dave.role, 'tenant');
  assert.deepEqual(config.proxy.clientKeys.at(-1), { name: 'dave', key: dave.key }, 'a tenant is the entry with no role');
  assert.notEqual(dave.key, carol.key);

  // No role at all is a tenant too.
  assert.equal(addClientKey(config, { name: 'erin' }).role, 'tenant');
});

test('addClientKey refuses a missing, taken or malformed name, and an unknown role', () => {
  const config = userConfig();
  const before = JSON.stringify(config);
  refused(() => addClientKey(config, { name: '' }), /needs a name/);
  refused(() => addClientKey(config, { name: '   ' }), /needs a name/);
  refused(() => addClientKey(config, { name: 42 }), /needs a name/);
  refused(() => addClientKey(config, { name: ' bob ' }), /already a user named "bob"/);
  refused(() => addClientKey(config, { name: 'b\nob' }), /control characters/);
  refused(() => addClientKey(config, { name: 'x'.repeat(65) }), /64 characters/);
  refused(() => addClientKey(config, { name: 'zed', role: 'root' }), /tenant, admin or readonly/);
  assert.equal(JSON.stringify(config), before, 'a refused add must not have half-applied');
});

// With no proxy.apiKey and no client keys the proxy has no auth at all; the
// first client key turns it on for every remote caller, who has no key.
test('addClientKey refuses on a proxy with no shared key, which the first user would lock out', () => {
  const config = { proxy: {} };
  refused(() => addClientKey(config, { name: 'bob' }), /set proxy\.apiKey first/);
  assert.deepEqual(config, { proxy: {} });
  refused(() => addClientKey({}, { name: 'bob' }), /set proxy\.apiKey first/);
});

test('removeClientKey removes every entry of the name, and refuses an unknown one', () => {
  const config = userConfig();
  assert.deepEqual(removeClientKey(config, 'ci'), { name: 'ci', removed: 2 });
  assert.deepEqual(config.proxy.clientKeys.map(e => e.name), ['alice', 'bob']);
  assert.deepEqual(removeClientKey(config, ' bob '), { name: 'bob', removed: 1 });
  refused(() => removeClientKey(config, 'zed'), /no user named "zed"/);
  refused(() => removeClientKey(config, ''), /name a user/);
});

test('removeClientKey refuses the caller removing themselves', () => {
  const config = userConfig();
  refused(() => removeClientKey(config, 'alice', { actor: 'alice' }), /cannot remove the key you are signed in with/);
  assert.equal(config.proxy.clientKeys.length, 4);
  assert.deepEqual(removeClientKey(config, 'bob', { actor: 'alice' }), { name: 'bob', removed: 1 });
});

test('removeClientKey refuses the last user on a proxy with no shared key, which would open it', () => {
  const config = { proxy: { clientKeys: [{ name: 'bob', key: 'tc-bob' }, { name: 'eve', key: 'tc-eve' }] } };
  removeClientKey(config, 'eve');
  refused(() => removeClientKey(config, 'bob'), /no proxy\.apiKey/);
  assert.equal(config.proxy.clientKeys.length, 1);
});

test('setClientKeyRole sets the role on every entry of the name, and tenant clears it', () => {
  const config = userConfig();
  assert.deepEqual(setClientKeyRole(config, 'bob', 'admin'), { name: 'bob', role: 'admin' });
  assert.equal(config.proxy.clientKeys[1].role, 'admin');
  assert.deepEqual(setClientKeyRole(config, 'ci', 'tenant'), { name: 'ci', role: 'tenant' });
  assert.ok(config.proxy.clientKeys.slice(2).every(e => !('role' in e)), 'a tenant is the entry with no role');
  assert.equal(config.proxy.clientKeys[2].key, 'tc-ci-1', 'the key is untouched');

  refused(() => setClientKeyRole(config, 'zed', 'admin'), /no user named "zed"/);
  refused(() => setClientKeyRole(config, 'bob', 'owner'), /tenant, admin or readonly/);
  assert.equal(config.proxy.clientKeys[1].role, 'admin');
});

test('setClientKeyRole refuses the caller demoting themselves, but not re-affirming admin', () => {
  const config = userConfig();
  refused(() => setClientKeyRole(config, 'alice', 'readonly', { actor: 'alice' }), /cannot take admin from the key you are signed in with/);
  refused(() => setClientKeyRole(config, 'alice', 'tenant', { actor: 'alice' }), /cannot take admin/);
  assert.equal(config.proxy.clientKeys[0].role, 'admin');
  assert.deepEqual(setClientKeyRole(config, 'alice', 'admin', { actor: 'alice' }), { name: 'alice', role: 'admin' });
});

test('rotateClientKey replaces only the entry holding the presented key', () => {
  const config = userConfig();
  const out = rotateClientKey(config, { name: 'ci', key: 'tc-ci-2' });
  assert.equal(out.name, 'ci');
  assert.match(out.key, /^tc-[A-Za-z0-9_-]{32}$/, 'the same shape as an added user\'s key');
  assert.deepEqual(config.proxy.clientKeys.map(e => e.key), ['tc-alice', 'tc-bob', 'tc-ci-1', out.key],
    'the name\'s other key keeps working, and the entry keeps its place');
  assert.equal(config.proxy.clientKeys[3].role, 'readonly', 'the role stays');
  assert.notEqual(rotateClientKey(config, { name: 'bob', key: 'tc-bob' }).key, out.key);
});

test('rotateClientKey refuses a key that is not the named user\'s', () => {
  const config = userConfig();
  refused(() => rotateClientKey(config, { name: 'bob', key: 'tc-alice' }), /no longer in the config/);
  refused(() => rotateClientKey(config, { name: 'bob', key: 'tc-gone' }), /no longer in the config/);
  refused(() => rotateClientKey(config, { name: 'bob' }), /no longer in the config/);
  refused(() => rotateClientKey(config, { name: '', key: 'tc-bob' }), /name a user/);
  assert.deepEqual(config.proxy.clientKeys.map(e => e.key), ['tc-alice', 'tc-bob', 'tc-ci-1', 'tc-ci-2']);
});
