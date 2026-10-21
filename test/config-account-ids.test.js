import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, atomicConfigUpdate } from '../src/config.js';

// A running server persists a refreshed token by re-reading the file and
// finding the account's row by entry id. A row that reaches the file without an
// id is given a fresh one by every load, so the id the server took when it
// picked the account up never matches the file again: each refresh is skipped,
// the file keeps the first refresh token while the server rotates past it, and
// the next restart reads a token upstream has already retired. A dashboard
// login adds its row through atomicConfigUpdate, which is how that happened.

async function withConfig(raw, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-config-ids-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(raw));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = path;
  try {
    await fn(path);
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG; else process.env.TEAMCLAUDE_CONFIG = prev;
  }
}

test('a row added through atomicConfigUpdate reaches the file with an id, and keeps it', async () => {
  await withConfig({ accounts: [{ id: 'a1', name: 'a', type: 'oauth', refreshToken: 'r-a' }] }, async (path) => {
    await atomicConfigUpdate(config => {
      config.accounts.push({ name: 'b', type: 'oauth', refreshToken: 'r-b' });
    });
    const written = JSON.parse(await readFile(path, 'utf-8'));
    const id = written.accounts[1].id;
    assert.ok(typeof id === 'string' && id !== '', `the new row carries an id: ${JSON.stringify(written.accounts[1])}`);
    assert.equal(written.accounts[0].id, 'a1', 'an existing id is left alone');

    // What the server holds after picking the row up is what the next token
    // write looks for, and the file must still answer to it.
    assert.equal((await loadConfig()).accounts[1].id, id);
    await atomicConfigUpdate(config => {
      const row = config.accounts.find(a => a.id === id);
      assert.ok(row, 'the token write finds the row by the id the server holds');
      row.refreshToken = 'r-b2';
    });
    const after = JSON.parse(await readFile(path, 'utf-8'));
    assert.equal(after.accounts[1].id, id);
    assert.equal(after.accounts[1].refreshToken, 'r-b2');
  });
});
