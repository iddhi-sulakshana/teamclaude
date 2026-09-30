import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, createProxyRequestListener, adminOnlyEffortReplacement } from '../src/server.js';

// proxy.adminOnlyEfforts keeps effort levels to the operator and "admin" client
// keys: any other caller has the matching effort swapped for the replacement
// before the request is forwarded.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const PROXY_KEY = 'tc-test';
const CLIENT_KEYS = [
  { name: 'ci', key: 'tc-tenant' },
  { name: 'boss', key: 'tc-admin', role: 'admin' },
  { name: 'watcher', key: 'tc-readonly', role: 'readonly' },
];
const ADMIN_ONLY = { xhigh: 'medium', max: 'medium' };

function account() {
  return new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
}

async function fakeUpstream() {
  /** @type {any[]} */
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const port = await listen(server);
  return { server, port, bodies };
}

async function setup({ adminOnlyEfforts = ADMIN_ONLY, trustLoopback = false } = {}) {
  const up = await fakeUpstream();
  const proxy = createProxyServer(account(), {
    proxy: { apiKey: PROXY_KEY, trustLoopback, clientKeys: CLIENT_KEYS, adminOnlyEfforts },
    upstream: `http://127.0.0.1:${up.port}`,
  });
  const port = await listen(proxy);
  return {
    bodies: up.bodies,
    post: (key, body) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      body: JSON.stringify(body),
    }),
    close() { proxy.close(); up.server.close(); },
  };
}

const request = effort => ({ model: 'claude-opus-5-5', output_config: { effort }, messages: [] });

test('adminOnlyEffortReplacement: a listed level names the replacement, anything else is null', () => {
  assert.equal(adminOnlyEffortReplacement(ADMIN_ONLY, 'max'), 'medium');
  assert.equal(adminOnlyEffortReplacement(ADMIN_ONLY, 'XHigh'), 'medium', 'levels compare case-insensitively');
  assert.equal(adminOnlyEffortReplacement(ADMIN_ONLY, 'high'), null);
  assert.equal(adminOnlyEffortReplacement(ADMIN_ONLY, null), null);
  assert.equal(adminOnlyEffortReplacement(undefined, 'max'), null);
  assert.equal(adminOnlyEffortReplacement(['max'], 'max'), null, 'an array is not a map');
  assert.equal(adminOnlyEffortReplacement({ max: '' }, 'max'), null, 'an empty replacement is ignored');
});

for (const [key, who] of [['tc-tenant', 'a tenant key'], ['tc-readonly', 'a readonly key']]) {
  test(`${who} asking for xhigh or max is sent medium`, async () => {
    const t = await setup();
    try {
      for (const effort of ['xhigh', 'max']) {
        const res = await t.post(key, request(effort));
        await res.text();
        assert.equal(res.status, 200);
      }
      assert.deepEqual(t.bodies.map(b => b.output_config.effort), ['medium', 'medium']);
    } finally { t.close(); }
  });
}

test('a tenant asking for high or below is forwarded as sent', async () => {
  const t = await setup();
  try {
    for (const effort of ['low', 'medium', 'high']) {
      const res = await t.post('tc-tenant', request(effort));
      await res.text();
    }
    assert.deepEqual(t.bodies.map(b => b.output_config.effort), ['low', 'medium', 'high']);
  } finally { t.close(); }
});

test('a tenant sending no effort is forwarded as sent', async () => {
  const t = await setup();
  try {
    const res = await t.post('tc-tenant', { model: 'claude-opus-5-5', messages: [] });
    await res.text();
    assert.equal(t.bodies[0].output_config, undefined);
  } finally { t.close(); }
});

test('a per-message effort in a system message is sent medium too', async () => {
  const t = await setup();
  try {
    const res = await t.post('tc-tenant', {
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: [], output_config: { effort: 'max' } },
      ],
    });
    await res.text();
    assert.equal(t.bodies[0].messages[1].output_config.effort, 'medium');
  } finally { t.close(); }
});

for (const [key, who, trustLoopback] of [
  ['tc-admin', 'an admin key', false],
  [PROXY_KEY, 'the shared proxy key', false],
  [null, 'a key-exempt local caller', true],
]) {
  test(`${who} keeps max`, async () => {
    const t = await setup({ trustLoopback });
    try {
      const res = await t.post(key, request('max'));
      await res.text();
      assert.equal(res.status, 200);
      assert.equal(t.bodies[0].output_config.effort, 'max');
    } finally { t.close(); }
  });
}

test('without adminOnlyEfforts a tenant keeps max', async () => {
  const t = await setup({ adminOnlyEfforts: null });
  try {
    const res = await t.post('tc-tenant', request('max'));
    await res.text();
    assert.equal(t.bodies[0].output_config.effort, 'max');
  } finally { t.close(); }
});

for (const [forcedClient, expected, why] of [
  ['ci', 'medium', 'a tenant'],
  ['boss', 'max', 'an admin key'],
  [null, 'max', 'the shared key or a local caller'],
  ['gone', 'medium', 'a name no longer in clientKeys'],
]) {
  test(`in a MITM tunnel, ${why} is sent ${expected}`, async () => {
    const up = await fakeUpstream();
    const server = http.createServer(createProxyRequestListener({
      accountManager: account(),
      upstream: `http://127.0.0.1:${up.port}`,
      config: { proxy: { apiKey: PROXY_KEY, clientKeys: CLIENT_KEYS, adminOnlyEfforts: ADMIN_ONLY } },
      forcedClient,
    }));
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request('max')),
      });
      await res.text();
      assert.equal(res.status, 200);
      assert.equal(up.bodies[0].output_config.effort, expected);
    } finally { server.close(); up.server.close(); }
  });
}
