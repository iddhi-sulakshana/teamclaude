import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { ConfigOpError } from '../src/config-ops.js';
import { beginPastedCodeLogin, completePastedCodeLogin } from '../src/oauth.js';
import { PendingLogins } from '../src/pending-logins.js';

// The dashboard's Add account: POST /teamclaude/login/start hands the page a
// sign-in link, POST /teamclaude/login/finish takes the code Claude showed.
// The PKCE verifier lives in the server between the two.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ── the login halves ─────────────────────────────────────────

test('the sign-in link carries the challenge and state, never the verifier', () => {
  const login = beginPastedCodeLogin();
  const url = new URL(login.url);
  assert.equal(url.origin + url.pathname, 'https://claude.ai/oauth/authorize');
  assert.equal(url.searchParams.get('state'), login.state);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(login.codeVerifier).digest('base64url'));
  assert.equal(url.searchParams.get('redirect_uri'), login.redirectUri);
  assert.ok(!login.url.includes(login.codeVerifier), 'the verifier is the secret half');
  // Two links never share a state or a verifier.
  const other = beginPastedCodeLogin();
  assert.notEqual(other.state, login.state);
  assert.notEqual(other.codeVerifier, login.codeVerifier);
});

async function tokenServer() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, seen, endpoint: `http://127.0.0.1:${srv.address().port}/token` };
}

test('finishing exchanges the pasted code against the login that started it', async () => {
  const { srv, seen, endpoint } = await tokenServer();
  try {
    const login = beginPastedCodeLogin();
    const creds = await completePastedCodeLogin(login, `  the-code#${login.state}\n`, { tokenEndpoint: endpoint });
    assert.equal(creds.accessToken, 'AT');
    assert.equal(creds.refreshToken, 'RT');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].code, 'the-code');
    assert.equal(seen[0].state, login.state);
    assert.equal(seen[0].code_verifier, login.codeVerifier);
    assert.equal(seen[0].grant_type, 'authorization_code');
  } finally {
    srv.close();
  }
});

test('a code carrying another login\'s state is refused before anything is sent', async () => {
  const { srv, seen, endpoint } = await tokenServer();
  try {
    const login = beginPastedCodeLogin();
    await assert.rejects(completePastedCodeLogin(login, 'the-code#someone-elses-state', { tokenEndpoint: endpoint }), /state mismatch/);
    await assert.rejects(completePastedCodeLogin(login, '   ', { tokenEndpoint: endpoint }), /No authorization code/);
    assert.equal(seen.length, 0);
  } finally {
    srv.close();
  }
});

// ── the pending-login table ──────────────────────────────────

const LOGIN = state => ({ url: `https://claude.ai/oauth/authorize?state=${state}`, state, codeVerifier: `v-${state}`, redirectUri: 'r' });

test('a pending login answers only what the page may see', () => {
  const logins = new PendingLogins({ now: () => 1000, ttlMs: 60_000 });
  assert.deepEqual(logins.add(LOGIN('a')), { url: LOGIN('a').url, state: 'a', expiresAt: 61_000 });
});

test('a pending login lapses, and a lapsed or unknown state finds nothing', () => {
  let now = 0;
  const logins = new PendingLogins({ now: () => now, ttlMs: 1000 });
  logins.add(LOGIN('a'));
  assert.equal(logins.use('a')?.codeVerifier, 'v-a');
  now = 1000;
  assert.equal(logins.use('a'), null, 'lapsed');
  assert.equal(logins.use('never-started'), null);
  assert.equal(logins.use(undefined), null);
  assert.equal(logins.use({ state: 'a' }), null);
});

test('each link allows a bounded number of pastes, and a finished one is gone', () => {
  const logins = new PendingLogins({ attempts: 2 });
  logins.add(LOGIN('a'));
  assert.ok(logins.use('a'), 'first paste');
  assert.ok(logins.use('a'), 'second paste');
  assert.equal(logins.use('a'), null, 'no third');
  logins.add(LOGIN('b'));
  logins.done('b');
  assert.equal(logins.use('b'), null);
});

test('the table keeps a bounded number of links, dropping the oldest', () => {
  const logins = new PendingLogins({ max: 2 });
  logins.add(LOGIN('a'));
  logins.add(LOGIN('b'));
  logins.add(LOGIN('c'));
  assert.equal(logins.use('a'), null, 'the oldest made room');
  assert.ok(logins.use('b'));
  assert.ok(logins.use('c'));
});

// ── the endpoints ────────────────────────────────────────────

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

function stubHooks({ finish } = {}) {
  const calls = { start: 0, finish: [], reload: 0 };
  const hooks = {
    startLogin: () => { calls.start++; return { url: 'https://claude.ai/oauth/authorize?state=s1', state: 's1', expiresAt: 123 }; },
    finishLogin: async (state, code) => {
      calls.finish.push([state, code]);
      if (finish) return finish(state, code);
      return { action: 'added', name: 'new@example.com' };
    },
    reload: async () => { calls.reload++; return 0; },
  };
  return { hooks, calls };
}

async function withServer(hooks, fn) {
  const am = new AccountManager([{ name: 'alice@example.com', type: 'apikey', apiKey: 'k1' }], 0.98);
  const proxy = createProxyServer(am, CONFIG, hooks);
  const port = await listen(proxy);
  try {
    await fn(port);
  } finally {
    proxy.close();
  }
}

const post = (port, path, body, key = PROXY_KEY) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
      'sec-fetch-site': 'same-origin',
      'x-api-key': key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('start answers the link and its state; finish adds the account and reloads', async () => {
  const { hooks, calls } = stubHooks();
  await withServer(hooks, async (port) => {
    const start = await post(port, '/teamclaude/login/start', undefined, ADMIN_KEY);
    assert.equal(start.status, 200);
    assert.deepEqual(await start.json(), { ok: true, url: 'https://claude.ai/oauth/authorize?state=s1', state: 's1', expiresAt: 123 });

    const finish = await post(port, '/teamclaude/login/finish', { state: 's1', code: 'abc#s1' }, ADMIN_KEY);
    assert.equal(finish.status, 200);
    assert.deepEqual(await finish.json(), { ok: true, action: 'added', name: 'new@example.com' });
    assert.deepEqual(calls.finish, [['s1', 'abc#s1']]);
    assert.equal(calls.reload, 1, 'the new account goes live without a restart');
  });
});

test('finish without a state or a code is a 400 that reaches no hook', async () => {
  const { hooks, calls } = stubHooks();
  await withServer(hooks, async (port) => {
    for (const body of [{}, { state: 's1' }, { code: 'abc' }, { state: 's1', code: '   ' }, { state: 1, code: 'abc' }]) {
      const res = await post(port, '/teamclaude/login/finish', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { ok: false, error: 'missing "state" or "code"' });
    }
    assert.equal(calls.finish.length + calls.reload, 0);
  });
});

test('a refusal the operator can act on is echoed; anything else is generic', async () => {
  const known = stubHooks({ finish: () => { throw new ConfigOpError('the code was not accepted: invalid_grant'); } });
  await withServer(known.hooks, async (port) => {
    const res = await post(port, '/teamclaude/login/finish', { state: 's1', code: 'bad' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'the code was not accepted: invalid_grant' });
    assert.equal(known.calls.reload, 0, 'nothing was saved, so nothing to reload');
  });
  const broken = stubHooks({ finish: () => { throw new Error('disk on fire /secret/path'); } });
  await withServer(broken.hooks, async (port) => {
    const res = await post(port, '/teamclaude/login/finish', { state: 's1', code: 'abc' });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false, error: 'adding the account failed; see the proxy log' });
  });
});

test('only the operator may add an account: tenant and readonly keys are refused', async () => {
  const { hooks, calls } = stubHooks();
  await withServer(hooks, async (port) => {
    for (const path of ['/teamclaude/login/start', '/teamclaude/login/finish']) {
      const body = path.endsWith('finish') ? { state: 's1', code: 'abc' } : undefined;
      const tenant = await post(port, path, body, TENANT_KEY);
      assert.equal(tenant.status, 403, `tenant ${path}`);
      assert.deepEqual(await tenant.json(), { ok: false, error: 'a client key cannot change accounts' });
      const readonly = await post(port, path, body, READONLY_KEY);
      assert.equal(readonly.status, 403, `readonly ${path}`);
    }
    assert.equal(calls.start + calls.finish.length, 0, 'a refused request reaches no hook');
    // The shared key is the operator too.
    assert.equal((await post(port, '/teamclaude/login/start')).status, 200);
  });
});

test('a server without the login hooks says so rather than half-working', async () => {
  await withServer({ reload: async () => 0 }, async (port) => {
    for (const path of ['/teamclaude/login/start', '/teamclaude/login/finish']) {
      const res = await post(port, path, { state: 's1', code: 'abc' });
      assert.equal(res.status, 501, path);
      assert.deepEqual(await res.json(), { ok: false, error: 'adding an account is not supported by this server' });
    }
  });
});
