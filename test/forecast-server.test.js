import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// trustLoopback off: the test client is on loopback, and the exemption would
// otherwise let a key-less request through and prove nothing about the gate.
const PROXY = {
  apiKey: 'shared-key',
  trustLoopback: false,
  clientKeys: [
    { name: 'alice', key: 'alice-key' },
    { name: 'ops', key: 'ops-key', role: 'admin' },
    { name: 'ro', key: 'ro-key', role: 'readonly' },
  ],
};
const apiFleet = () => new AccountManager([{ name: 'acct', type: 'api_key', apiKey: 'sk-a' }], 0.98);

async function withProxy(am, config, hooks, fn) {
  const proxy = createProxyServer(am, config, hooks);
  const port = await listen(proxy);
  try {
    await fn(port);
  } finally {
    proxy.close();
  }
}

const post = (port, path, key) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: key ? { 'x-api-key': key } : {} });

test('GET /teamclaude/forecast serves the hook behind the status gate', async () => {
  await withProxy(apiFleet(), { proxy: PROXY }, { getForecast: () => ({ verdict: 'on-pace' }) }, async port => {
    const url = `http://127.0.0.1:${port}/teamclaude/forecast`;
    assert.equal((await fetch(url)).status, 401);
    for (const key of ['shared-key', 'alice-key', 'ro-key']) {
      const res = await fetch(url, { headers: { 'x-api-key': key } });
      assert.equal(res.status, 200, key);
      assert.deepEqual(await res.json(), { verdict: 'on-pace' }, key);
    }
  });
});

test('GET /teamclaude/forecast answers 501 when no forecast is wired', async () => {
  await withProxy(apiFleet(), { proxy: PROXY }, {}, async port => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/forecast`, { headers: { 'x-api-key': 'shared-key' } });
    assert.equal(res.status, 501);
  });
});

test('POST /teamclaude/forecast/explain is the operator\'s, and hands over the caller\'s key', async () => {
  const keys = [];
  const hooks = { explainForecast: async ({ key }) => { keys.push(key); return { text: 'Because.', generatedAt: 5, cached: false }; } };
  await withProxy(apiFleet(), { proxy: PROXY }, hooks, async port => {
    assert.equal((await post(port, '/teamclaude/forecast/explain', 'alice-key')).status, 403, 'a tenant');
    assert.equal((await post(port, '/teamclaude/forecast/explain', 'ro-key')).status, 403, 'read-only');
    const res = await post(port, '/teamclaude/forecast/explain', 'shared-key');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, text: 'Because.', generatedAt: 5, cached: false });
    assert.equal((await post(port, '/teamclaude/forecast/explain', 'ops-key')).status, 200, 'an admin key');
  });
  assert.deepEqual(keys, ['shared-key', 'ops-key']);
});

test('an explain failure keeps its status and message; anything else is a bare 500', async () => {
  let failure = Object.assign(new Error('Claude Code CLI not found on the server'), { status: 503 });
  await withProxy(apiFleet(), { proxy: PROXY }, { explainForecast: async () => { throw failure; } }, async port => {
    let res = await post(port, '/teamclaude/forecast/explain', 'shared-key');
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'Claude Code CLI not found on the server' });
    failure = new Error('ENOENT /root/secret');
    res = await post(port, '/teamclaude/forecast/explain', 'shared-key');
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false, error: 'explain failed' });
  });
  await withProxy(apiFleet(), { proxy: PROXY }, {}, async port => {
    assert.equal((await post(port, '/teamclaude/forecast/explain', 'shared-key')).status, 501);
  });
});

// An upstream that answers every request with the next weekly reading.
function quotaUpstream(readings) {
  const reset = String(Math.floor(Date.now() / 1000) + 86400);
  return http.createServer((_req, res) => {
    const u = readings.shift() ?? 0;
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-7d-utilization': String(u),
      'anthropic-ratelimit-unified-7d-reset': reset,
    });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}

async function postMessages(port, key) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  await res.text();
  return res.status;
}

test('a Claude response books the weekly quota it moved to the client that sent it', async () => {
  const upstream = quotaUpstream([0.10, 0.12, 0.15]);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'max', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
    rateLimitTier: 'default_claude_max_20x',
  }], 0.98);
  const booked = [];
  try {
    await withProxy(am, { proxy: PROXY, upstream: `http://127.0.0.1:${upstreamPort}` },
      { recordQuotaUse: (client, amount) => booked.push([client, amount]) }, async port => {
        assert.equal(await postMessages(port, 'alice-key'), 200);   // first reading: nothing to rise from
        assert.equal(await postMessages(port, 'alice-key'), 200);   // 0.10 → 0.12
        assert.equal(await postMessages(port, 'shared-key'), 200);  // 0.12 → 0.15, no client key
      });
  } finally {
    upstream.close();
  }
  assert.equal(booked.length, 2);
  assert.equal(booked[0][0], 'alice');
  assert.ok(Math.abs(booked[0][1] - 0.4) < 1e-9, String(booked[0][1]));
  assert.equal(booked[1][0], null);
  assert.ok(Math.abs(booked[1][1] - 0.6) < 1e-9, String(booked[1][1]));
});

test('an API-key account books nothing', async () => {
  const upstream = quotaUpstream([0.10, 0.50]);
  const upstreamPort = await listen(upstream);
  const booked = [];
  try {
    await withProxy(apiFleet(), { proxy: PROXY, upstream: `http://127.0.0.1:${upstreamPort}` },
      { recordQuotaUse: (client, amount) => booked.push([client, amount]) }, async port => {
        await postMessages(port, 'alice-key');
        await postMessages(port, 'alice-key');
      });
  } finally {
    upstream.close();
  }
  assert.deepEqual(booked, []);
});
