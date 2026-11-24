import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { updateAccountEntry } from '../src/identity.js';
import { mergeAccountsForSave } from '../src/account-pairing.js';

// accounts[].owner names the user (a proxy.clientKeys name) whose own seat the
// account is. While the seat needs a re-login that user is paused (see
// seatPauseFor in server.js), so the field has to reach the running account,
// follow a reload, and survive every write that rebuilds the row: a re-login
// and a save.

const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 'T', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra });

test('an account carries its owner, trimmed; a blank or non-string owner is none', () => {
  const am = new AccountManager([
    oauth('a@x', { owner: ' bob ' }),
    oauth('b@x', { owner: '' }),
    oauth('c@x', { owner: 7 }),
  ], 0.98);
  assert.deepEqual(am.accounts.map(a => a.owner), ['bob', null, null]);
});

test('a reload applies an owner edit and a removal, and mirrors it onto the config entry', async () => {
  const entry = { name: 's@x', type: 'apikey', apiKey: 'k1', owner: 'bob' };
  const mem = [{ ...entry }];
  const am = new AccountManager([{ ...entry }], 0.98);
  assert.equal(am.accounts[0].owner, 'bob');

  await syncAccountsFromDisk({ accounts: [{ ...entry, owner: 'carol' }] }, { accounts: mem }, am);
  assert.equal(am.accounts[0].owner, 'carol');
  assert.equal(mem[0].owner, 'carol');

  await syncAccountsFromDisk({ accounts: [{ name: 's@x', type: 'apikey', apiKey: 'k1' }] }, { accounts: mem }, am);
  assert.equal(am.accounts[0].owner, null);
  assert.equal('owner' in mem[0], false, 'a stale owner on the config entry would win the next save');
});

test('a re-login keeps the owner', () => {
  const row = updateAccountEntry(
    { name: 's@x', type: 'oauth', owner: 'bob', refreshToken: 'old' },
    { name: 's@x', type: 'oauth', refreshToken: 'new' },
  );
  assert.equal(row.owner, 'bob');
  assert.equal(row.refreshToken, 'new');
});

test('a save keeps the owner on disk', () => {
  const cfg = [{ id: 'id-1', name: 's@x', type: 'apikey', apiKey: 'k1', owner: 'bob' }];
  const am = new AccountManager(cfg.map(a => ({ ...a })), 0.98);
  const disk = [{ id: 'id-1', name: 's@x', type: 'apikey', apiKey: 'k1', owner: 'bob' }];
  const merged = mergeAccountsForSave(cfg, am.accounts, disk);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].owner, 'bob');
});
