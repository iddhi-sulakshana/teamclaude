import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { addClientKey, removeClientKey, setClientKeyRole } from '../src/config-ops.js';

// POST /teamclaude/users/add, /users/remove and /users/role are what the
// dashboard's Users card calls. Like the account controls, the write is the
// hook's and the reload after it the server's; unlike them, one of the three
// answers a credential, so the tests also hold the key out of status and the
// log, and check it is live the moment the call returns.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const PROXY_KEY = 'tc-test';
const ADMIN_KEY = 'tc-alice';
const TENANT_KEY = 'tc-bob';
const READONLY_KEY = 'tc-carol';

const freshConfig = () => ({
  proxy: {
    apiKey: PROXY_KEY,
    clientKeys: [
      { name: 'alice', key: ADMIN_KEY, role: 'admin' },
      { name: 'bob', key: TENANT_KEY },
      { name: 'carol', key: READONLY_KEY, role: 'readonly' },
    ],
  },
  upstream: 'http://127.0.0.1:9',
});

// Hooks that do what the real ones do — the config-ops op on the config — but
// on the live object, which stands in for the write to disk and the reload
// that copies proxy.clientKeys back into the running server.
function liveHooks(config) {
  const calls = { add: [], remove: [], role: [], reload: 0 };
  const hooks = {
    addUser: async (spec) => { calls.add.push(spec); return addClientKey(config, spec); },
    removeUser: async (name, spec) => { calls.remove.push([name, spec]); return removeClientKey(config, name, spec); },
    setUserRole: async (name, role, spec) => { calls.role.push([name, role, spec]); return setClientKeyRole(config, name, role, spec); },
    reload: async () => { calls.reload++; return 0; },
  };
  return { hooks, calls };
}

async function withServer(config, hooks, fn) {
  const am = new AccountManager([{ name: 'acct@example.com', type: 'apikey', apiKey: 'k1' }], 0.98);
  const proxy = createProxyServer(am, config, hooks);
  const port = await listen(proxy);
  try {
    await fn(port);
  } finally {
    proxy.close();
  }
}

// A same-origin browser POST, as the page sends it. The requests carry a key
// only when the test is about who is asking; loopback is otherwise exempt.
const post = (port, path, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

// The key gate as a remote caller meets it. Loopback is exempt from the key,
// so "is this key accepted" is asked with a forwarding header, which the
// exemption does not cover.
const statusAs = (port, key) =>
  fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
    headers: { ...(key ? { 'x-api-key': key } : {}), 'x-forwarded-for': '203.0.113.9' },
  });

async function capturingLogs(fn) {
  const lines = [];
  const { log, error } = console;
  console.log = (...args) => { lines.push(args.join(' ')); };
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    await fn(lines);
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('adding a user answers the key once, reloads, and the key is live at once', async () => {
  const config = freshConfig();
  const { hooks, calls } = liveHooks(config);
  await withServer(config, hooks, async (port) => {
    await capturingLogs(async (lines) => {
      const res = await post(port, '/teamclaude/users/add', { name: 'dave', role: 'readonly' }, { 'x-api-key': ADMIN_KEY });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.name, 'dave');
      assert.equal(body.role, 'readonly');
      assert.match(body.key, /^tc-/);
      assert.equal(calls.reload, 1);

      assert.ok(lines.some(l => /Added user "dave" \(readonly\).*by alice/.test(l)), 'the change is logged with who made it');
      assert.ok(lines.every(l => !l.includes(body.key)), 'the key never reaches the log');

      const as = await statusAs(port, body.key);
      assert.equal(as.status, 200, 'the new key authenticates right away');
      const status = await as.json();
      assert.deepEqual(status.viewer, { client: 'dave', role: 'readonly' });
      assert.ok(!JSON.stringify(status).includes(body.key), 'status never carries a key');
    });
  });
});

test('removing a user refuses their key at once', async () => {
  const config = freshConfig();
  const { hooks, calls } = liveHooks(config);
  await withServer(config, hooks, async (port) => {
    assert.equal((await statusAs(port, TENANT_KEY)).status, 200);
    const res = await post(port, '/teamclaude/users/remove', { name: 'bob' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, name: 'bob', removed: 1 });
    assert.equal(calls.reload, 1);
    assert.equal((await statusAs(port, TENANT_KEY)).status, 401, 'a removed key is refused');
  });
});

test('changing a role takes effect on the next request', async () => {
  const config = freshConfig();
  const { hooks } = liveHooks(config);
  await withServer(config, hooks, async (port) => {
    const res = await post(port, '/teamclaude/users/role', { name: 'bob', role: 'admin' }, { 'x-api-key': PROXY_KEY });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, name: 'bob', role: 'admin' });
    const status = await (await statusAs(port, TENANT_KEY)).json();
    assert.deepEqual(status.viewer, { client: 'bob', role: 'operator' });
  });
});

test('the caller is passed as the actor, so an admin cannot remove or demote themselves', async () => {
  const config = freshConfig();
  const { hooks, calls } = liveHooks(config);
  await withServer(config, hooks, async (port) => {
    const rm = await post(port, '/teamclaude/users/remove', { name: 'alice' }, { 'x-api-key': ADMIN_KEY });
    assert.equal(rm.status, 400);
    assert.match((await rm.json()).error, /cannot remove the key you are signed in with/);
    const demote = await post(port, '/teamclaude/users/role', { name: 'alice', role: 'tenant' }, { 'x-api-key': ADMIN_KEY });
    assert.equal(demote.status, 400);
    assert.match((await demote.json()).error, /cannot take admin/);
    assert.equal(calls.reload, 0, 'a refused change has nothing to reload');
    assert.equal(calls.remove[0][1].actor, 'alice');

    // The shared key has no name, so it can remove the admin.
    const ok = await post(port, '/teamclaude/users/remove', { name: 'alice' }, { 'x-api-key': PROXY_KEY });
    assert.equal(ok.status, 200);
    assert.equal(calls.remove[1][1].actor, null);
  });
});

test('a tenant or read-only key cannot change users', async () => {
  const config = freshConfig();
  const { hooks, calls } = liveHooks(config);
  await withServer(config, hooks, async (port) => {
    for (const [path, body] of [
      ['/teamclaude/users/add', { name: 'eve', role: 'admin' }],
      ['/teamclaude/users/remove', { name: 'alice' }],
      ['/teamclaude/users/role', { name: 'bob', role: 'admin' }],
    ]) {
      const tenant = await post(port, path, body, { 'x-api-key': TENANT_KEY });
      assert.equal(tenant.status, 403, path);
      assert.deepEqual(await tenant.json(), { ok: false, error: 'a client key cannot change users' });
      const ro = await post(port, path, body, { 'x-api-key': READONLY_KEY });
      assert.equal(ro.status, 403, path);
    }
    assert.equal(calls.add.length + calls.remove.length + calls.role.length + calls.reload, 0);
  });
});

test('status lists the users by name and role for an operator only, never their keys', async () => {
  const config = freshConfig();
  config.proxy.clientKeys.push({ name: 'bob', key: 'tc-bob-2' });
  const { hooks } = liveHooks(config);
  await withServer(config, hooks, async (port) => {
    const op = await (await statusAs(port, PROXY_KEY)).json();
    assert.deepEqual(op.users, [
      { name: 'alice', role: 'admin' },
      { name: 'bob', role: 'tenant' },
      { name: 'carol', role: 'readonly' },
    ], 'one row per name');
    for (const key of [ADMIN_KEY, TENANT_KEY, READONLY_KEY, 'tc-bob-2']) {
      assert.ok(!JSON.stringify(op).includes(key));
    }
    const tenant = await (await statusAs(port, TENANT_KEY)).json();
    assert.equal('users' in tenant, false, 'a tenant is not shown who else holds a key');
  });
});

test('bad input is a 400 that reaches no hook; a refused op is a 400 with its reason', async () => {
  const config = freshConfig();
  const { hooks, calls } = liveHooks(config);
  await withServer(config, hooks, async (port) => {
    for (const path of ['/teamclaude/users/add', '/teamclaude/users/remove', '/teamclaude/users/role']) {
      for (const body of [{}, { name: '' }, { name: 42 }, 'null']) {
        const res = await post(port, path, body);
        assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
        assert.deepEqual(await res.json(), { ok: false, error: 'missing "name"' });
      }
      const bad = await post(port, path, '{not json');
      assert.equal(bad.status, 400);
      assert.deepEqual(await bad.json(), { ok: false, error: 'invalid request body' });
    }
    assert.equal(calls.add.length + calls.remove.length + calls.role.length, 0);

    const dup = await post(port, '/teamclaude/users/add', { name: 'bob' });
    assert.equal(dup.status, 400);
    assert.match((await dup.json()).error, /already a user named "bob"/);
    assert.equal(calls.reload, 0);
  });
});

test('an unexpected failure is a generic 500; a failed reload says the file changed', async () => {
  const config = freshConfig();
  const { hooks } = liveHooks(config);
  hooks.removeUser = async () => { throw new Error('EACCES: /etc/teamclaude/config.json'); };
  hooks.reload = async () => { throw new Error('boom'); };
  await withServer(config, hooks, async (port) => {
    await capturingLogs(async (lines) => {
      const rm = await post(port, '/teamclaude/users/remove', { name: 'bob' });
      assert.equal(rm.status, 500);
      assert.deepEqual(await rm.json(), { ok: false, error: 'user change failed; see the proxy log' });

      const add = await post(port, '/teamclaude/users/add', { name: 'dave' });
      assert.equal(add.status, 500);
      assert.deepEqual(await add.json(), { ok: false, error: 'saved to the config file, but the reload failed; see the proxy log' });
      const key = config.proxy.clientKeys.at(-1).key;
      assert.ok(lines.every(l => !l.includes(key)), 'not even a failure logs the key');
    });
  });
});

test('a server without the user hooks or a reload answers 501 before any write', async () => {
  const config = freshConfig();
  const { hooks, calls } = liveHooks(config);
  delete hooks.reload;
  await withServer(config, hooks, async (port) => {
    const res = await post(port, '/teamclaude/users/add', { name: 'dave' });
    assert.equal(res.status, 501);
    assert.equal(calls.add.length, 0);
  });
  await withServer(freshConfig(), { reload: async () => 0 }, async (port) => {
    const res = await post(port, '/teamclaude/users/role', { name: 'bob', role: 'admin' });
    assert.equal(res.status, 501);
    assert.match((await res.json()).error, /not supported/);
  });
});
