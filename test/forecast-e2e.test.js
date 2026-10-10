import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnServer, closedPort } from '../test-helpers/spawn-server.js';

test('the real server serves a forecast and saves its quota history', async () => {
  const deadPort = await closedPort();
  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: `http://127.0.0.1:${deadPort}`,
      upstreamProxy: false,
      accounts: [{
        name: 'max@example.com', type: 'oauth', accessToken: 't', refreshToken: 'r',
        expiresAt: Date.now() + 86_400_000, rateLimitTier: 'default_claude_max_20x',
      }],
    }),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/teamclaude/forecast`, { headers: { 'x-api-key': 'tc-test' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.verdict, null);
    assert.equal(body.reason, 'no-quota', 'one Claude subscription, no weekly reading yet');
  } finally {
    await server.stop();
  }
  const state = JSON.parse(await readFile(join(server.dir, 'config.state.json'), 'utf8'));
  const histories = Object.values(state.quotaHistory || {});
  assert.equal(histories.length, 1, 'the startup sample was saved on shutdown');
  assert.ok(histories[0].length >= 1);
  assert.ok('clientQuota' in state);
});
