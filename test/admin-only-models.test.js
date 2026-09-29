import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, createProxyRequestListener, adminOnlyReplacement } from '../src/server.js';

// proxy.adminOnlyModels keeps a model family to the operator and "admin" client
// keys: any other caller has the matching model swapped for the replacement
// before the request is routed, so it is served — and spends quota — as that
// model instead.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const PROXY_KEY = 'tc-test';
const CLIENT_KEYS = [
  { name: 'ci', key: 'tc-tenant' },
  { name: 'boss', key: 'tc-admin', role: 'admin' },
  { name: 'watcher', key: 'tc-readonly', role: 'readonly' },
];
const ADMIN_ONLY = { '*fable*': 'claude-opus-5-5' };

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

async function setup({ adminOnlyModels = ADMIN_ONLY, trustLoopback = false, blockedModels } = {}) {
  const up = await fakeUpstream();
  /** @type {string[]} */
  const models = [];
  const hooks = { onRequestModel: (_id, { model }) => models.push(model) };
  const proxy = createProxyServer(account(), {
    proxy: { apiKey: PROXY_KEY, trustLoopback, clientKeys: CLIENT_KEYS, adminOnlyModels },
    upstream: `http://127.0.0.1:${up.port}`,
    ...(blockedModels ? { blockedModels } : {}),
  }, hooks);
  const port = await listen(proxy);
  return {
    bodies: up.bodies,
    models,
    post: (key, body) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      body: JSON.stringify(body),
    }),
    close() { proxy.close(); up.server.close(); },
  };
}

test('adminOnlyReplacement: a matching glob names the replacement, anything else is null', () => {
  assert.equal(adminOnlyReplacement(ADMIN_ONLY, 'claude-fable-5-1'), 'claude-opus-5-5');
  assert.equal(adminOnlyReplacement(ADMIN_ONLY, 'claude-opus-5-5'), null);
  assert.equal(adminOnlyReplacement(ADMIN_ONLY, null), null);
  assert.equal(adminOnlyReplacement(undefined, 'claude-fable-5-1'), null);
  assert.equal(adminOnlyReplacement(['*fable*'], 'claude-fable-5-1'), null, 'an array is not a map');
  assert.equal(adminOnlyReplacement({ '*fable*': 42 }, 'claude-fable-5-1'), null, 'a non-string replacement is ignored');
  assert.equal(adminOnlyReplacement({ '*fable*': '' }, 'claude-fable-5-1'), null, 'an empty replacement is ignored');
});

test('a tenant key asking for Fable is served Opus', async () => {
  const t = await setup();
  try {
    const res = await t.post('tc-tenant', { model: 'claude-fable-5-1', messages: [] });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.bodies.length, 1);
    assert.equal(t.bodies[0].model, 'claude-opus-5-5');
    assert.equal(t.models.at(-1), 'claude-opus-5-5', 'the activity row shows the model actually served');
  } finally { t.close(); }
});

test('a readonly key asking for Fable is served Opus', async () => {
  const t = await setup();
  try {
    const res = await t.post('tc-readonly', { model: 'claude-fable-5-1', messages: [] });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.bodies[0].model, 'claude-opus-5-5');
  } finally { t.close(); }
});

test('an admin key keeps Fable', async () => {
  const t = await setup();
  try {
    const res = await t.post('tc-admin', { model: 'claude-fable-5-1', messages: [] });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.bodies[0].model, 'claude-fable-5-1');
  } finally { t.close(); }
});

test('the shared proxy key keeps Fable', async () => {
  const t = await setup();
  try {
    const res = await t.post(PROXY_KEY, { model: 'claude-fable-5-1', messages: [] });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.bodies[0].model, 'claude-fable-5-1');
  } finally { t.close(); }
});

test('a key-exempt local caller keeps Fable', async () => {
  const t = await setup({ trustLoopback: true });
  try {
    const res = await t.post(null, { model: 'claude-fable-5-1', messages: [] });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.bodies[0].model, 'claude-fable-5-1');
  } finally { t.close(); }
});

test('a tenant asking for a model that is not admin-only is forwarded as sent', async () => {
  const t = await setup();
  try {
    const res = await t.post('tc-tenant', { model: 'claude-sonnet-5-5', messages: [] });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.bodies[0].model, 'claude-sonnet-5-5');
  } finally { t.close(); }
});

test("a tenant's advisor tool naming Fable is served Opus too", async () => {
  const t = await setup();
  try {
    const res = await t.post('tc-tenant', {
      model: 'claude-opus-5-5',
      tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-fable-5-1' }],
      messages: [],
    });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.bodies[0].model, 'claude-opus-5-5');
    assert.equal(t.bodies[0].tools[0].model, 'claude-opus-5-5');
  } finally { t.close(); }
});

test('without adminOnlyModels a tenant keeps Fable', async () => {
  const t = await setup({ adminOnlyModels: null });
  try {
    const res = await t.post('tc-tenant', { model: 'claude-fable-5-1', messages: [] });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.bodies[0].model, 'claude-fable-5-1');
  } finally { t.close(); }
});

test('blockedModels judges the model that would be sent, after the downgrade', async () => {
  const t = await setup({ blockedModels: ['*opus*'] });
  try {
    const res = await t.post('tc-tenant', { model: 'claude-fable-5-1', messages: [] });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.match(body.error.message, /claude-opus-5-5/);
    assert.equal(t.bodies.length, 0, 'never forwarded');
  } finally { t.close(); }
});

// Inside a MITM tunnel the key was checked at CONNECT time and only the
// client's name reaches the request listener, so its role is looked up in the
// live clientKeys.
async function tunnelListener(forcedClient) {
  const up = await fakeUpstream();
  const server = http.createServer(createProxyRequestListener({
    accountManager: account(),
    upstream: `http://127.0.0.1:${up.port}`,
    config: { proxy: { apiKey: PROXY_KEY, clientKeys: CLIENT_KEYS, adminOnlyModels: ADMIN_ONLY } },
    forcedClient,
  }));
  const port = await listen(server);
  return {
    bodies: up.bodies,
    post: body => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    close() { server.close(); up.server.close(); },
  };
}

for (const [forcedClient, expected, why] of [
  ['ci', 'claude-opus-5-5', 'a tenant'],
  ['watcher', 'claude-opus-5-5', 'a readonly key'],
  ['boss', 'claude-fable-5-1', 'an admin key'],
  [null, 'claude-fable-5-1', 'the shared key or a local caller'],
  ['gone', 'claude-opus-5-5', 'a name no longer in clientKeys'],
]) {
  test(`in a MITM tunnel, ${why} is served ${expected}`, async () => {
    const t = await tunnelListener(forcedClient);
    try {
      const res = await t.post({ model: 'claude-fable-5-1', messages: [] });
      await res.text();
      assert.equal(res.status, 200);
      assert.equal(t.bodies[0].model, expected);
    } finally { t.close(); }
  });
}
