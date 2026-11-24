import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { seatPauseFor, pausedSeat, seatPausedMessage, createProxyServer, createProxyRequestListener } from '../src/server.js';
import { createConnectHandler } from '../src/mitm.js';
import { generateCertChain } from '../src/x509.js';
import { allowLoopbackForward } from '../src/forward-target.js';

// A non-admin user is paused while a seat they own (accounts[].owner) needs a
// re-login (status 'error'), and back the moment it works again. Nothing is
// written anywhere: every gate works it out from the live account status, so a
// ban an admin set by hand (clientKeys[].disabled) is a separate thing this
// never reads or lifts.

const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 'T', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra });

const PROXY = {
  apiKey: 'shared-key',
  clientKeys: [
    { name: 'alice', key: 'alice-key', role: 'admin' },
    { name: 'bob', key: 'bob-key', role: 'readonly' },
    { name: 'droplet', key: 'droplet-key', role: 'readonly' },
  ],
};

function fleet(...accounts) {
  return new AccountManager(accounts, 0.98).accounts;
}

test('seatPauseFor names the seat in error that the user owns', () => {
  const accounts = fleet(oauth('bob@x', { owner: 'bob' }));
  assert.equal(seatPauseFor(accounts, PROXY, 'bob'), null, 'a working seat pauses no one');
  for (const status of ['throttled', 'exhausted']) {
    accounts[0].status = status;
    assert.equal(seatPauseFor(accounts, PROXY, 'bob'), null, `${status} is not a re-login`);
  }
  accounts[0].status = 'error';
  assert.equal(seatPauseFor(accounts, PROXY, 'bob'), 'bob@x');
});

test('seatPauseFor exempts admins and users with no seat', () => {
  const accounts = fleet(oauth('alice@x', { owner: 'alice' }), oauth('bob@x', { owner: 'bob' }));
  for (const a of accounts) a.status = 'error';
  assert.equal(seatPauseFor(accounts, PROXY, 'alice'), null, 'an admin is never paused');
  assert.equal(seatPauseFor(accounts, PROXY, 'droplet'), null, 'a user with no seat is never paused');
});

test('seatPauseFor pauses on any one of several seats, and on a seat that is also disabled', () => {
  const accounts = fleet(oauth('bob-1@x', { owner: 'bob' }), oauth('bob-2@x', { owner: 'bob' }));
  accounts[1].status = 'error';
  assert.equal(seatPauseFor(accounts, PROXY, 'bob'), 'bob-2@x');

  const off = fleet(oauth('bob@x', { owner: 'bob', disabled: true }));
  off[0].status = 'error';
  assert.equal(seatPauseFor(off, PROXY, 'bob'), 'bob@x', 'an admin turning the dead seat off does not let its owner back in');
});

test('seatPausedMessage names the seat and the way back', () => {
  assert.equal(
    seatPausedMessage('ruchira@747.live'),
    "Your Claude seat (ruchira@747.live) needs a re-login, so your key is paused. Ask an admin for a sign-in link; your key turns back on by itself once you've signed in.",
  );
});

test('pausedSeat logs once on pause and once on return', () => {
  const proxy = { clientKeys: [{ name: 'u-log', key: 'k' }] };
  const accounts = fleet(oauth('s-log@x', { owner: 'u-log' }));
  accounts[0].status = 'error';
  const lines = [];
  const log = line => lines.push(line);

  assert.equal(pausedSeat(accounts, proxy, 'u-log', log), 's-log@x');
  assert.equal(pausedSeat(accounts, proxy, 'u-log', log), 's-log@x');
  assert.equal(lines.filter(l => /User "u-log" paused: their seat "s-log@x" needs a re-login/.test(l)).length, 1);
  assert.equal(lines.length, 1);

  accounts[0].status = 'active';
  assert.equal(pausedSeat(accounts, proxy, 'u-log', log), null);
  assert.equal(pausedSeat(accounts, proxy, 'u-log', log), null);
  assert.equal(lines.filter(l => /User "u-log" back on/.test(l)).length, 1);
  assert.equal(lines.length, 2);
});

test('pausedSeat warns once per loaded user list about an owner that names nobody', () => {
  const accounts = fleet(oauth('ghost-seat@x', { owner: 'ghost' }));
  const lines = [];
  const log = line => lines.push(line);
  const proxy = { clientKeys: [{ name: 'u-warn', key: 'k' }] };

  pausedSeat(accounts, proxy, 'u-warn', log);
  pausedSeat(accounts, proxy, 'u-warn', log);
  const warned = () => lines.filter(l => /"ghost-seat@x" has owner "ghost", but there is no user by that name/.test(l)).length;
  assert.equal(warned(), 1);

  // A reload hands the server a new clientKeys array.
  pausedSeat(accounts, { clientKeys: [...proxy.clientKeys] }, 'u-warn', log);
  assert.equal(warned(), 2);
});

// --- The gates. Each refuses a paused user wherever a disabled key is refused
// today, and lets them back in the moment the seat works again. The fleet is an
// API-key account that serves, plus bob's own seat, whose status the tests flip.

const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));

function stubUpstream() {
  const up = http.createServer((req, res) => {
    up.reached++;
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  up.reached = 0;
  return up;
}

const gateFleet = (owner = 'bob') => new AccountManager([
  { name: 'a', type: 'apikey', apiKey: 'k1' },
  oauth(`${owner}@x`, { owner }),
], 0.98);

const post = (port, key) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
  body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1, messages: [] }),
});

async function withBaseServer(clientKeys, owner, fn) {
  const up = stubUpstream();
  const upPort = await listen(up);
  const am = gateFleet(owner);
  const config = { proxy: { apiKey: 'shared-key', clientKeys }, upstream: `http://127.0.0.1:${upPort}` };
  const proxy = createProxyServer(am, config);
  const port = await listen(proxy);
  try {
    await fn({ port, am, up, proxy });
  } finally {
    proxy.closeAllConnections?.();
    proxy.close();
    up.close();
  }
}

test('the base gate refuses a paused user with the reason, and lets them back once the seat works', async () => {
  await withBaseServer([{ name: 'bob', key: 'bob-key', role: 'readonly' }], 'bob', async ({ port, am, up }) => {
    am.accounts[1].status = 'error';
    const refused = await post(port, 'bob-key');
    assert.equal(refused.status, 403);
    const body = await refused.json();
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'permission_error');
    assert.equal(body.error.message, seatPausedMessage('bob@x'));
    assert.equal(up.reached, 0, 'the refused request never reaches upstream');

    am.accounts[1].status = 'active';
    const back = await post(port, 'bob-key');
    await back.text();
    assert.equal(back.status, 200);
  });
});

test('an admin who owns a dead seat, and a user with a hand ban, get their usual answers', async () => {
  await withBaseServer([{ name: 'alice', key: 'alice-key', role: 'admin' }], 'alice', async ({ port, am }) => {
    am.accounts[1].status = 'error';
    const res = await post(port, 'alice-key');
    await res.text();
    assert.equal(res.status, 200, 'an admin is never paused');
  });
  await withBaseServer([{ name: 'bob', key: 'bob-key', disabled: true }], 'bob', async ({ port, am }) => {
    am.accounts[1].status = 'error';
    const res = await post(port, 'bob-key');
    assert.equal(res.status, 403);
    assert.match((await res.json()).error.message, /disabled/, 'the hand ban is what the user is told');
  });
});

test('loopback without a key stays exempt while seats are dead', async () => {
  await withBaseServer([{ name: 'bob', key: 'bob-key' }], 'bob', async ({ port, am }) => {
    am.accounts[1].status = 'error';
    const res = await post(port, null);
    await res.text();
    assert.equal(res.status, 200);
  });
});

test('the base WebSocket upgrade refuses a paused user', async () => {
  await withBaseServer([{ name: 'bob', key: 'bob-key' }], 'bob', async ({ port, am }) => {
    am.accounts[1].status = 'error';
    const c = net.createConnection({ port, host: '127.0.0.1' });
    await once(c, 'connect');
    c.write('GET /v1/session_ingress/ws/abc HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
      + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nx-api-key: bob-key\r\n\r\n');
    const [reply] = await once(c, 'data');
    c.destroy();
    assert.match(reply.toString(), /^HTTP\/1\.1 403 /);
  });
});

test('CONNECT refuses a paused user', async () => {
  const am = gateFleet();
  am.accounts[1].status = 'error';
  const config = { proxy: { apiKey: 'shared-key', clientKeys: [{ name: 'bob', key: 'bob-key' }] } };
  const proxy = http.createServer();
  proxy.on('connect', createConnectHandler({ config, accountManager: am, ensureLeaf: async () => { throw new Error('no tunnel expected'); }, log: () => {} }));
  const port = await listen(proxy);
  try {
    const raw = net.connect(port, '127.0.0.1');
    await once(raw, 'connect');
    raw.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: Bearer bob-key\r\n\r\n');
    const [reply] = await once(raw, 'data');
    raw.destroy();
    assert.match(reply.toString(), /^HTTP\/1\.1 403 /);
  } finally {
    proxy.closeAllConnections?.();
    proxy.close();
  }
});

test('inside a MITM tunnel, a seat that dies refuses the next request and a seat that recovers lets the next one through', async () => {
  const up = stubUpstream();
  const upPort = await listen(up);
  const am = gateFleet();
  const config = { proxy: { apiKey: 'shared-key', clientKeys: [{ name: 'bob', key: 'bob-key' }] } };
  const tunnel = http.createServer(createProxyRequestListener({
    accountManager: am,
    upstream: `http://127.0.0.1:${upPort}`,
    config,
    forcedClient: 'bob',
  }));
  const port = await listen(tunnel);
  try {
    const first = await post(port, null);
    await first.text();
    assert.equal(first.status, 200);

    am.accounts[1].status = 'error';
    const refused = await post(port, null);
    assert.equal(refused.status, 403);
    const body = await refused.json();
    assert.equal(body.error.type, 'permission_error');
    assert.equal(body.error.message, seatPausedMessage('bob@x'));
    assert.equal(up.reached, 1, 'the refused request never reaches upstream');

    am.accounts[1].status = 'active';
    const back = await post(port, null);
    await back.text();
    assert.equal(back.status, 200);
  } finally {
    tunnel.closeAllConnections?.();
    tunnel.close();
    up.close();
  }
});

test('inside a MITM tunnel, a paused user cannot open a WebSocket', { timeout: 30000 }, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  let upgrades = 0;
  const up = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  up.on('upgrade', (req, socket) => {
    upgrades++;
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  const upPort = await listen(up);
  const am = gateFleet();
  const config = {
    upstream: `http://127.0.0.1:${upPort}`,
    mitm: { http1Only: true },
    proxy: { apiKey: 'shared-key', clientKeys: [{ name: 'bob', key: 'bob-key' }] },
  };
  const proxy = http.createServer();
  proxy.on('connect', createConnectHandler({
    config,
    accountManager: am,
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    log: () => {},
  }));
  allowLoopbackForward(proxy);
  const port = await listen(proxy);

  const raw = net.connect(port, '127.0.0.1');
  await once(raw, 'connect');
  raw.write(`CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\nHost: 127.0.0.1:${upPort}\r\nProxy-Authorization: Bearer bob-key\r\n\r\n`);
  const [connected] = await once(raw, 'data');
  assert.match(connected.toString(), / 200 /);
  const sock = tls.connect({ socket: raw, servername: 'localhost', ca: [caCertPem], ALPNProtocols: ['http/1.1'] });
  await once(sock, 'secureConnect');
  try {
    am.accounts[1].status = 'error';
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
