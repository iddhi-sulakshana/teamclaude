# Seat re-login pause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refuse a non-admin user's key while a seat they own is in the `error` ("needs a re-login") state, and let it back in the moment the seat works again.

**Architecture:** Each config account entry gets an optional `owner` (a `proxy.clientKeys` name), copied onto the running account and kept in sync on reload. A pure helper in `src/server.js` (`seatPauseFor`) answers "which seat pauses this user?" from live account status. A logging wrapper (`pausedSeat`) sits in the same five places that refuse a disabled key today. Nothing is written to the config; the Users card shows the derived state.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-24-seat-relogin-autodisable-design.md`

## Global Constraints

- Never write the config from this feature. The pause is derived on every check.
- Never read or write `clientKeys[].disabled` from this feature. A hand ban wins when both apply (its message is shown).
- Admin = every `clientKeys` entry for the name has `clientKeyRole(e) === 'admin'` (same rule as `isAdminCaller`).
- Only `account.status === 'error'` pauses, including on a seat that is also `disabled`.
- 403 body copy, exactly: `Your Claude seat (${seat}) needs a re-login, so your key is paused. Ask an admin for a sign-in link; your key turns back on by itself once you've signed in.`
- Dashboard chip copy, exactly: `off: seat needs re-login`.
- Tests run on `hetzner-iddhi`, never on the laptop: `rsync -az --delete --exclude .git --exclude node_modules ./ hetzner-iddhi:/root/work/teamclaude/`, then `ssh hetzner-iddhi 'cd /root/work/teamclaude && bun install --frozen-lockfile >/dev/null && PATH=/root/.local/share/fnm/node-versions/v26.13.1/installation/bin:$PATH node --test --test-timeout=120000 <files>'`.
- No commits unless the user asks. Work on branch `feat/seat-relogin-pause`.

## Review Focus

1. A loopback caller with no key is still exempt when seats are dead: there is no client name, so there's nothing to pause (Task 3 test).
2. A seat that recovers while a MITM tunnel is open: the next request in that tunnel passes, with no reconnect (Task 3 tunnel test flips back).
3. An `owner` written with stray whitespace (`" bob "`) still names `bob` (Task 1 test).
4. A seat in `error` that an admin has also disabled still pauses its owner (Task 2 test).
5. A tenant's status never shows another user's pause: `users` stays operator-only (Task 4 asserts `users` absent for a tenant with a paused peer).

---

### Task 1: `owner` on accounts

**Files:**
- Modify: `src/account-manager.js` (new export near `accountAllowsExtraUsage` ~255; `makeAccount` ~308)
- Modify: `src/sync-accounts.js` (per-account sync ~112 and the `cfgAcct` mirror ~170-190)
- Modify: `docs/configuration.md` (new `accounts[].owner` row after `accounts[].autoRedeemReset`)
- Test: `test/seat-owner.test.js`

**Interfaces:**
- Produces: `export function accountOwner(acct: any): string|null`, which returns the trimmed `acct.owner` when it is a non-blank string, otherwise `null`. Every running account carries `owner: string|null`.

- [ ] **Step 1: Write the failing tests** in `test/seat-owner.test.js`:
  - `an account carries its owner, trimmed; a blank or non-string owner is none`: three OAuth accounts with `owner: ' bob '`, `''`, `7` → `am.accounts.map(a => a.owner)` deepEqual `['bob', null, null]`.
  - `a reload applies an owner edit and a removal, and mirrors it onto the config entry`: set up like `test/reload-account-fields.test.js`. Disk `owner: 'bob'` → `'carol'` gives `mgr.owner === 'carol'` and `memConfig.accounts[0].owner === 'carol'`. Then disk without `owner` gives `mgr.owner === null` and `'owner' in memConfig.accounts[0] === false`.
  - `a re-login keeps the owner`: `updateAccountEntry({ name: 's@x', type: 'oauth', owner: 'bob', refreshToken: 'old' }, { name: 's@x', type: 'oauth', refreshToken: 'new' }).owner === 'bob'`.
  - `a save keeps the owner on disk`: `mergeAccountsForSave` with a config entry and a disk row, both with `owner: 'bob'` → the merged row has `owner === 'bob'`.
- [ ] **Step 2: Run them on hetzner-iddhi.** Expected: the first two fail (`owner` is undefined); the last two may already pass, because the spread code exists. They stay as pins.
- [ ] **Step 3: Implement.** Add `accountOwner`. Set `owner: accountOwner(acct)` in `makeAccount`. In `syncAccountsFromDisk`, set `mgr.owner = accountOwner(diskAcct)`, and in the `cfgAcct` mirror add `if (accountOwner(diskAcct)) cfgAcct.owner = diskAcct.owner; else delete cfgAcct.owner;`. Add the docs row: what it is (a `proxy.clientKeys` name), what it does (pauses that user while the seat needs a re-login; admins exempt; derived, never written), applied live on reload.
- [ ] **Step 4: Run `test/seat-owner.test.js` plus `test/reload-account-fields.test.js test/reload-then-save.test.js test/account-pairing.test.js`.** Expected: all pass.

### Task 2: the pause helper

**Files:**
- Modify: `src/server.js` (next to `userDisabled` ~458)
- Test: `test/seat-relogin-pause.test.js` (new)

**Interfaces:**
- Consumes: running accounts with `owner` and `status` (Task 1).
- Produces (all exported from `src/server.js`):
  - `seatPauseFor(accounts: any[], proxyConfig: any, name: string): string|null` returns the `name` of the first account with `owner === name` and `status === 'error'`. It returns `null` when there is none, or when the user is an admin (Global Constraints rule). It is pure: no logging.
  - `seatPausedMessage(seat: string): string` returns the 403 copy from Global Constraints.
  - `pausedSeat(accounts: any[], proxyConfig: any, name: string, log = console.log): string|null` returns the same value as `seatPauseFor` and also logs:
    - once when `name` becomes paused: `[TeamClaude] User "<name>" paused: their seat "<seat>" needs a re-login`
    - once when it is next seen unpaused: `[TeamClaude] User "<name>" back on: their seat works again`
    - once per loaded `proxyConfig.clientKeys` array (WeakSet, as `usableClientKeys` does), for each account whose owner names no clientKeys entry: `[TeamClaude] accounts: "<seat>" has owner "<owner>", but there is no user by that name — it pauses no one`

    Names go through `safeLine(…, 64)`. Transition state is a module-level `Map<name, seat>`.

- [ ] **Step 1: Write the failing tests:**
  - `seatPauseFor names the seat in error that the user owns`: owner `bob` with status `error` → `'bob@x'`; status `active`, `throttled` or `exhausted` → `null`.
  - `seatPauseFor exempts admins and users with no seat`: owner `alice` (role `admin`) in `error` → `null`; `droplet` (no seat) → `null`.
  - `seatPauseFor pauses on any one of several seats, and on a seat that is also disabled`: bob owns two seats, the second in `error` → its name. A seat with `disabled: true` and status `error` → still paused.
  - `pausedSeat logs once on pause and once on return`: two paused calls → exactly one line matching `/User "u-log" paused: their seat "s-log@x" needs a re-login/`. Flip the status to `active` and call twice → exactly one more line matching `/User "u-log" back on/`.
  - `pausedSeat warns once per loaded user list about an owner that names nobody`: owner `ghost`, two calls with the same `clientKeys` array → one line matching `/owner "ghost", but there is no user by that name/`. A new array → one more.
- [ ] **Step 2: Run on hetzner-iddhi.** Expected: FAIL (`seatPauseFor` is not exported).
- [ ] **Step 3: Implement the three functions.**
- [ ] **Step 4: Run `test/seat-relogin-pause.test.js`.** Expected: PASS.

### Task 3: refuse a paused user at every gate

**Files:**
- Modify: `src/server.js`: base gate after the invalid-key 401 (~587); base `upgrade` listener after `!auth.ok` (~1378); tunnel per-request check after the `userDisabled` block (~1701).
- Modify: `src/mitm.js`: CONNECT after `!auth.ok` (~350); tunnel `upgrade` after the `userDisabled` block (~284). Import `pausedSeat` from `./server.js`.
- Test: `test/seat-relogin-pause.test.js`

**Interfaces:**
- Consumes: `pausedSeat`, `seatPausedMessage` (Task 2); `accountManager.accounts`; `config.proxy`, read live.

Responses: where there is a body (base gate, tunnel per-request), send a 403 `{ type: 'error', error: { type: 'permission_error', message: seatPausedMessage(seat) } }`. CONNECT uses `refuseRaw(sock, '403 Forbidden')`. Both upgrade paths write the same bare 403 the disabled refusal writes, plus a log line naming the user. Only a named client is checked (`auth.client` / `forcedClient` / `client`). The disabled refusal stays first.

- [ ] **Step 1: Write the failing tests.** Model them on `test/user-disable.test.js`. The fleet is an API-key account `a` plus an OAuth seat `bob@x` with `owner: 'bob'`, and the test flips `am.accounts[1].status`.
  - `the base gate refuses a paused user with the reason, and lets them back once the seat works`: POST `/v1/messages` with bob's key to `createProxyServer` → 403, `permission_error`, message includes `bob@x` and `needs a re-login`, upstream stub never reached. Set status to `active` → 200.
  - `an admin who owns a dead seat, and a user with a hand ban, get their usual answers`: alice (admin) owns the dead seat → 200. Bob with `disabled: true` and a dead seat → message matches `/disabled/`.
  - `loopback without a key stays exempt while seats are dead`: a no-key POST from 127.0.0.1 → not 403.
  - `the base WebSocket upgrade refuses a paused user`: a raw `GET` with `Upgrade: websocket` and bob's `x-api-key` → reply starts with `HTTP/1.1 403`.
  - `CONNECT refuses a paused user`: `Proxy-Authorization: Bearer bob-key` → reply matches `/ 403 /`.
  - `inside a MITM tunnel, a seat that dies refuses the next request and a seat that recovers lets the next one through`: `createProxyRequestListener` with `forcedClient: 'bob'`. 200 → flip to `error` → 403 with the seat message → flip to `active` → 200.
  - `inside a MITM tunnel, a paused user cannot open a WebSocket`: as the last test in `user-disable.test.js`, but flip the seat status instead of setting `disabled`.
- [ ] **Step 2: Run on hetzner-iddhi.** Expected: the gate tests FAIL (200 where 403 is expected).
- [ ] **Step 3: Add the five checks.**
- [ ] **Step 4: Run `test/seat-relogin-pause.test.js test/user-disable.test.js test/upgrade-auth.test.js test/connect-auth.test.js test/mitm.test.js`.** Expected: all pass.

### Task 4: Users card shows the pause

**Files:**
- Modify: `src/server.js`: `configuredUsers(proxyConfig, accounts = [])` (~476) and its call in `/teamclaude/status` (~713), which passes `accountManager.accounts`.
- Modify: `src/dashboard.js`: the user row (~3646-3650).
- Test: `test/server-user-controls.test.js`, `test/dashboard.test.js`

**Interfaces:**
- Consumes: `seatPauseFor` (Task 2).
- Produces: a status `users[]` row gains `seatRelogin: string` (the seat's name) only when paused. Its shape becomes `{ name, role, disabled?: true, seatRelogin?: string }`.

- [ ] **Step 1: Write the failing tests:**
  - In `server-user-controls.test.js`, `status marks a user whose seat needs a re-login, for an operator only`: the fleet has an OAuth seat `bob@example.com` with `owner: 'bob'` in `error`. The operator's status `users` include `{ name: 'bob', role: 'tenant', seatRelogin: 'bob@example.com' }`, and the tenant's status has no `users`. (Bob is paused, so check the tenant view with carol's key, or with a second tenant added to the config.)
  - In `dashboard.test.js`, `a user paused by their seat is shown off, and the Disable button still controls only the hand ban`: `status.users[1] = { name: 'bob', role: 'tenant', seatRelogin: 'bob@747.live' }` → `page.classed('us-off')` deepEqual `['off: seat needs re-login']`, `page.classed('us-row off').length === 1`, `page.titled('Disable bob') === 1`. With `disabled: true` as well → `page.classed('us-off')` deepEqual `['disabled', 'off: seat needs re-login']`.
- [ ] **Step 2: Run both files on hetzner-iddhi.** Expected: the two new tests FAIL.
- [ ] **Step 3: Implement.** `configuredUsers` adds `seatRelogin` from `seatPauseFor`. The row is dimmed when `u.disabled || u.seatRelogin`. A second `us-off` chip carries the copy, with title `` `${u.seatRelogin} needs a re-login` ``.
- [ ] **Step 4: Run the full suite** (`node --test --test-timeout=120000`) plus `bun run lint` and `bun run typecheck` on hetzner-iddhi. Expected: everything passes, with no new lint or type errors.
