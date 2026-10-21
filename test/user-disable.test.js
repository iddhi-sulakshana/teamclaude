import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyRequestListener, resolveClientAuth, resolveUpgradeAuth } from '../src/server.js';
import { createConnectHandler, resolveConnectAuth } from '../src/mitm.js';
import { generateCertChain } from '../src/x509.js';
import { allowLoopbackForward } from '../src/forward-target.js';

// A user (proxy.clientKeys entry) with `disabled: true` keeps its key, role and
// usage, and every gate refuses the key: the HTTP one, CONNECT, the WebSocket
// handshake, and a MITM tunnel opened before the change. Loopback is exempt
// from presenting a key, not from presenting a disabled one.

const PROXY = {
  apiKey: 'shared-key',
  clientKeys: [
    { name: 'alice', key: 'alice-key' },
    { name: 'bob', key: 'bob-key', disabled: true },
  ],
};
const DISABLED = { ok: false, client: null, disabled: true };

test('resolveClientAuth refuses a disabled key and says why', () => {
  assert.deepEqual(resolveClientAuth(PROXY, 'bob-key'), DISABLED);
  assert.deepEqual(resolveClientAuth(PROXY, 'alice-key'), { ok: true, client: 'alice' });
  assert.deepEqual(resolveClientAuth(PROXY, 'wrong'), { ok: false, client: null }, 'an unknown key is not called disabled');
});

test('with no shared key and every user disabled, the gate stays shut', () => {
  // Dropping disabled entries from the list would leave no keys at all, which
  // is the configuration that opens the gate to every caller.
  const cfg = { clientKeys: [{ name: 'bob', key: 'bob-key', disabled: true }] };
  assert.deepEqual(resolveClientAuth(cfg, 'bob-key'), DISABLED);
  assert.deepEqual(resolveClientAuth(cfg, undefined), { ok: false, client: null });
});

const basic = (user, pass) => ({ headers: { 'proxy-authorization': `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` } });
const remote = { remoteAddress: '203.0.113.7' };
const local = { remoteAddress: '127.0.0.1' };

test('resolveConnectAuth refuses a disabled key in any slot, from loopback too', () => {
  for (const sock of [remote, local]) {
    const where = sock === local ? 'loopback' : 'remote';
    assert.deepEqual(resolveConnectAuth(basic('bob-key', ''), sock, PROXY), DISABLED, `${where}: Basic username`);
    assert.deepEqual(resolveConnectAuth(basic('some-account', 'bob-key'), sock, PROXY), DISABLED, `${where}: Basic password`);
    assert.deepEqual(resolveConnectAuth({ headers: { 'proxy-authorization': 'Bearer bob-key' } }, sock, PROXY), DISABLED, `${where}: Bearer`);
  }
  assert.deepEqual(resolveConnectAuth({ headers: {} }, local, PROXY), { ok: true, client: null }, 'no key from loopback is still exempt');
});

test('resolveUpgradeAuth refuses a disabled key, from loopback too', () => {
  const headers = { host: 'localhost:8484' };
  assert.deepEqual(resolveUpgradeAuth({ headers: { ...headers, 'x-api-key': 'bob-key' } }, local, PROXY), DISABLED);
  assert.deepEqual(resolveUpgradeAuth({ headers }, local, PROXY), { ok: true, client: null }, 'no key from loopback is still exempt');
});

test('in a MITM tunnel, a user disabled after the CONNECT is refused on the next request', async () => {
  let reached = 0;
  const up = http.createServer((req, res) => {
    reached++;
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  await new Promise(resolve => up.listen(0, '127.0.0.1', resolve));
  // The key was checked at CONNECT time; only the name rides along, and the
  // reload that disables the user edits this same live config.
  const config = { proxy: { apiKey: 'shared-key', clientKeys: [{ name: 'bob', key: 'bob-key' }] } };
  const tunnel = http.createServer(createProxyRequestListener({
    accountManager: new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98),
    upstream: `http://127.0.0.1:${up.address().port}`,
    config,
    forcedClient: 'bob',
  }));
  await new Promise(resolve => tunnel.listen(0, '127.0.0.1', resolve));
  const send = () => fetch(`http://127.0.0.1:${tunnel.address().port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1, messages: [] }),
  });
  try {
    const before = await send();
    await before.text();
    assert.equal(before.status, 200);

    config.proxy.clientKeys = [{ name: 'bob', key: 'bob-key', disabled: true }];
    const after = await send();
    assert.equal(after.status, 403);
    const body = await after.json();
    assert.equal(body.error.type, 'permission_error');
    assert.match(body.error.message, /disabled/);
    assert.equal(reached, 1, 'the refused request never reaches upstream');
  } finally {
    tunnel.close();
    up.close();
  }
});

test('in a MITM tunnel, a user disabled after the CONNECT cannot open a WebSocket', { timeout: 30000 }, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  let upgrades = 0;
  const up = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  up.on('upgrade', (req, socket) => {
    upgrades++;
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  await new Promise(resolve => up.listen(0, '127.0.0.1', resolve));
  const upPort = up.address().port;
  const config = {
    upstream: `http://127.0.0.1:${upPort}`,
    mitm: { http1Only: true },
    proxy: { apiKey: 'shared-key', clientKeys: [{ name: 'bob', key: 'bob-key' }] },
  };
  const proxy = http.createServer();
  proxy.on('connect', createConnectHandler({
    config,
    accountManager: new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'T', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98),
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    log: () => {},
  }));
  allowLoopbackForward(proxy);
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));

  const raw = net.connect(proxy.address().port, '127.0.0.1');
  await once(raw, 'connect');
  raw.write(`CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\nHost: 127.0.0.1:${upPort}\r\nProxy-Authorization: Bearer bob-key\r\n\r\n`);
  const [connected] = await once(raw, 'data');
  assert.match(connected.toString(), / 200 /);
  const sock = tls.connect({ socket: raw, servername: 'localhost', ca: [caCertPem], ALPNProtocols: ['http/1.1'] });
  await once(sock, 'secureConnect');
  try {
    config.proxy.clientKeys = [{ name: 'bob', key: 'bob-key', disabled: true }];
    sock.write(`GET /v1/session_ingress/ws/abc HTTP/1.1\r\nHost: 127.0.0.1:${upPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    const [reply] = await once(sock, 'data');
    assert.match(reply.toString(), /^HTTP\/1\.1 403 /);
    assert.equal(upgrades, 0, 'nothing reached the upstream');
  } finally {
    sock.destroy();
    proxy.closeAllConnections?.();
    proxy.close();
    up.close();
  }
});
