import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveClientAuth, clientKeyRole, controlRole } from '../src/server.js';
import { modeFor } from '../src/mcp-tools.js';

// proxy.clientKeys[].role moves a client key off the tenant line in either
// direction: "admin" is the operator's control plane under the key's own name,
// "readonly" may watch and nothing else. A key without a role keeps the tenant
// rules the account-controls tests pin down.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const PROXY_KEY = 'tc-test';
const TENANT_KEY = 'tc-tenant';
const ADMIN_KEY = 'tc-admin';
const READONLY_KEY = 'tc-readonly';
const CONFIG = {
  proxy: {
    apiKey: PROXY_KEY,
    trustLoopback: false,
    clientKeys: [
      { name: 'ci', key: TENANT_KEY },
      { name: 'boss', key: ADMIN_KEY, role: 'admin' },
      { name: 'watcher', key: READONLY_KEY, role: 'readonly' },
    ],
  },
  upstream: 'http://127.0.0.1:9',
};
const ACCTS = [
  { name: 'alice@example.com', type: 'apikey', apiKey: 'k1' },
  { name: 'bob@example.com', type: 'apikey', apiKey: 'k2' },
];

function stubHooks() {
  const calls = { priority: [], disabled: [], reload: 0, probe: 0 };
  const hooks = {
    setAccountPriority: async (account, spec) => {
      calls.priority.push([account, spec]);
      return { name: account, priority: spec.place === 'first' ? -1 : spec.priority };
    },
    setAccountDisabled: async (account, disabled) => {
      calls.disabled.push([account, disabled]);
      return { name: account, disabled };
    },
    reload: async () => { calls.reload++; return 0; },
    probe: async () => { calls.probe++; return { ok: true }; },
  };
  return { hooks, calls };
}

async function withServer(hooks, fn) {
  const am = new AccountManager(ACCTS, 0.98);
  const proxy = createProxyServer(am, CONFIG, hooks);
  const port = await listen(proxy);
  try {
    await fn(port, am);
  } finally {
    proxy.close();
  }
}

// The dashboard's own request: a same-origin browser POST carrying a key.
const post = (port, path, body, key) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
      'sec-fetch-site': 'same-origin',
      'x-api-key': key,
    },
    body: JSON.stringify(body),
  });

const status = (port, key) =>
  fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': key } }).then(r => r.json());

test('a role is read case-insensitively, and an unknown one fails closed to readonly', () => {
  assert.equal(clientKeyRole({ name: 'a', key: 'k' }), null);
  assert.equal(clientKeyRole({ role: 'admin' }), 'admin');
  assert.equal(clientKeyRole({ role: ' Admin ' }), 'admin');
  assert.equal(clientKeyRole({ role: 'readonly' }), 'readonly');
  // A typo must not leave a key with more than was asked for.
  assert.equal(clientKeyRole({ role: 'admn' }), 'readonly');
  assert.equal(clientKeyRole({ role: 1 }), 'readonly');
});

test('the control-plane role: no client name or an admin key is the operator', () => {
  assert.equal(controlRole(null, null), 'operator');
  assert.equal(controlRole('boss', 'admin'), 'operator');
  assert.equal(controlRole('ci', null), 'tenant');
  assert.equal(controlRole('watcher', 'readonly'), 'readonly');
});

test('resolveClientAuth hands back the matching entry\'s role', () => {
  assert.deepEqual(resolveClientAuth(CONFIG.proxy, ADMIN_KEY), { ok: true, client: 'boss', role: 'admin' });
  assert.deepEqual(resolveClientAuth(CONFIG.proxy, READONLY_KEY), { ok: true, client: 'watcher', role: 'readonly' });
  // No role, no field: every older caller sees the answer it always did.
  assert.deepEqual(resolveClientAuth(CONFIG.proxy, TENANT_KEY), { ok: true, client: 'ci' });
  assert.deepEqual(resolveClientAuth(CONFIG.proxy, PROXY_KEY), { ok: true, client: null });
  assert.equal(resolveClientAuth(CONFIG.proxy, 'tc-nope').ok, false);
});

test('only an admin client key reaches the MCP write tools', () => {
  assert.equal(modeFor('full', 'boss', 'admin'), 'full');
  assert.equal(modeFor('full', 'ci', null), 'read');
  assert.equal(modeFor('full', 'watcher', 'readonly'), 'read');
  assert.equal(modeFor('full', null), 'full');
  // An admin key is still held to what proxy.mcp allows.
  assert.equal(modeFor('read', 'boss', 'admin'), 'read');
});

test('a read-only client key is refused every control, runtime nudges included', async () => {
  const { hooks, calls } = stubHooks();
  await withServer(hooks, async (port, am) => {
    const before = am.currentIndex;
    for (const [path, body] of [
      ['/teamclaude/switch', { account: 'bob@example.com' }],
      ['/teamclaude/reload', {}],
      ['/teamclaude/probe', {}],
      ['/teamclaude/priority', { account: 'alice@example.com', place: 'first' }],
      ['/teamclaude/disable', { account: 'alice@example.com', disabled: true }],
      ['/teamclaude/threshold', { percent: 50 }],
      // A route that does not exist yet is refused too: the rule is the prefix.
      ['/teamclaude/some-future-control', {}],
    ]) {
      const res = await post(port, path, body, READONLY_KEY);
      assert.equal(res.status, 403, path);
      assert.deepEqual(await res.json(), { ok: false, error: 'a read-only client key cannot change anything' }, path);
    }
    assert.equal(am.currentIndex, before, 'the switch never happened');
    assert.equal(calls.priority.length + calls.disabled.length + calls.reload + calls.probe, 0, 'a refused request reaches no hook');
  });
});

test('an admin client key may change accounts, which a plain client key may not', async () => {
  const { hooks, calls } = stubHooks();
  await withServer(hooks, async (port) => {
    const refused = await post(port, '/teamclaude/disable', { account: 'alice@example.com', disabled: true }, TENANT_KEY);
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { ok: false, error: 'a client key cannot change accounts' });

    const ok = await post(port, '/teamclaude/disable', { account: 'alice@example.com', disabled: true }, ADMIN_KEY);
    assert.equal(ok.status, 200);
    const moved = await post(port, '/teamclaude/priority', { account: 'bob@example.com', place: 'first' }, ADMIN_KEY);
    assert.equal(moved.status, 200);
    assert.equal(calls.disabled.length, 1);
    assert.equal(calls.priority.length, 1);
  });
});

test('a plain client key keeps the runtime switch it always had', async () => {
  const { hooks } = stubHooks();
  await withServer(hooks, async (port, am) => {
    const res = await post(port, '/teamclaude/switch', { account: 'bob@example.com' }, TENANT_KEY);
    assert.equal(res.status, 200);
    assert.equal(am.accounts[am.currentIndex].name, 'bob@example.com');
  });
});

test('status names the viewer as the control plane will treat them', async () => {
  const { hooks } = stubHooks();
  await withServer(hooks, async (port) => {
    assert.deepEqual((await status(port, ADMIN_KEY)).viewer, { client: 'boss', role: 'operator' });
    assert.deepEqual((await status(port, READONLY_KEY)).viewer, { client: 'watcher', role: 'readonly' });
    assert.deepEqual((await status(port, TENANT_KEY)).viewer, { client: 'ci', role: 'tenant' });
    assert.deepEqual((await status(port, PROXY_KEY)).viewer, { client: null, role: 'operator' });
  });
});
