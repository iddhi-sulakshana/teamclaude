# Pause a user while their own seat needs a re-login — design

Date: 2026-11-24
Status: approach approved in conversation; this doc awaits approval

## Why

On 2026-11-23 at 17:30 UTC, ruchira@747.live's refresh token was rejected and
the seat went to "needs re-login". Ruchira kept using the pool on other
people's seats until an admin turned his key off by hand at 05:39 UTC the next
day. teamclaude should do that on its own: while your seat is broken, you
don't get to spend everyone else's.

## What it does

- When a seat goes to "needs re-login", its owner's key stops working right
  away, with no grace period.
- When the seat works again (re-login), the key works again right away, with
  no admin step.
- Admins (clientKeys role `admin`, currently leo and iddhi) are never paused.
- A ban an admin set by hand (`disabled: true`) is never lifted by this rule.

## Non-goals

- No dashboard, TUI or CLI editor for the seat→user mapping. It is set in the
  config file.
- No Telegram or other notification when someone is paused.
- Paused users still can't start their own re-login. That stays admin-only
  (`/teamclaude/login/start`), as today.

## Anti-goals (a failure even if it works)

- The rule writes to the config file. It must not.
- A hand-set ban comes off because a seat recovered.
- An admin, or a user with no seat (`droplet`), gets locked out.

## Approaches

- **A, derived at auth time (picked).** Wherever a key is checked today, also
  check "does this non-admin user own a seat in `error`?" and refuse if so.
  Nothing is stored. Re-enabling needs no code because the check simply stops
  matching. Hand bans stay separate because this rule never reads or writes
  `disabled`.
- **B, a flag in the config.** On the error transition, write
  `disabled: true` plus `disabledReason: 'seat-relogin'`, and clear it on
  re-login. The existing gates work unchanged. Rejected because the server
  would write the config from runtime events, and the edge cases pile up: an
  admin bans someone who is already auto-off, a seat is removed while its owner
  is off, two writes race.
- **C, a periodic reconciler.** Rejected: it reacts late and still writes the
  config.

## Design

**Mapping.** A new optional field on each config account entry,
`owner: "<clientKeys name>"`. The user gave the map (2026-11-24):

| seat | owner |
|---|---|
| leo@747.live | leo (admin, exempt) |
| iddhi@747.live | iddhi (admin, exempt) |
| buddhima, ravindu, ruchira, shehan, amantha, pramod, kaveesha, srinath @747.live | same name |
| chamodhperera@747.live | chamodh |
| ekanayaka@747.live | anuja |

`droplet` owns no seat. The field survives a re-login (`updateAccountEntry`
spreads the new tokens over the old row) and a save (`mergeAccountsForSave`
spreads memory over the disk row). Both were checked in the code; tests pin
them. A reload must apply an `owner` change without a restart.

**The check.** One shared helper answers "which seat, if any, pauses this
user?": a seat whose `owner` is the user, whose live status is `error`, and
whose owner is not an admin. Admin is decided the way `isAdminCaller` already
decides it (by name: every entry for the name says `admin`).

**Where it applies.** The same five places that refuse a disabled key today:

1. base request gate (`src/server.js` ~578)
2. WebSocket upgrade on the base listener (`src/server.js` ~1363)
3. MITM CONNECT (`src/mitm.js` ~339)
4. MITM per-request check inside a tunnel (`src/server.js` ~1697)
5. MITM WebSocket upgrade (`src/mitm.js` ~278)

A hand ban wins when both apply, so the user sees the existing
`DISABLED_KEY_MESSAGE`. Otherwise the refusal is a 403 in Anthropic's error
shape (`permission_error`) where there is a body, with a message like: "Your
Claude seat (ruchira@747.live) needs a re-login, so your key is paused. Ask an
admin for a sign-in link; your key turns back on by itself once you've signed
in." CONNECT and upgrades get a bare 403, as they do for disabled keys now.

**Dashboard.** The Users card shows a paused user as "off: seat needs
re-login", visibly different from a hand-disabled user. The enable/disable
button keeps controlling only the hand ban. `configuredUsers` gets a flag for
this, computed from the account manager.

**Restarts.** `error` lives in memory only, so after a restart a dead seat
starts out `active`. The quota probe (droplet: `quotaProbeSeconds: 60`) runs
once at startup and forces a refresh, so the seat is back in `error`, and its
owner paused, within seconds. With the probe off, that happens on the first
request routed to the seat. This is accepted.

## Calls I made (check these)

- **Any `error` on a seat counts**, not only the rejected-refresh path. The
  other path (an OAuth 401 that no refresh fixes, `markCredentialRejected`)
  shows the same "needs a re-login" on the dashboard and has the same fix.
- **A user who owns several seats** is paused while any one of them needs a
  re-login. Nobody owns more than one today.
- **The pause covers every gate, the dashboard included**, same as a disabled
  key. The 403 carries the reason. Letting a paused user still read the
  dashboard would be friendlier but adds a carve-out in the gate.
- **An admin re-enabling a dead seat** (which clears its `error`) lifts the
  pause until the next probe rejects the token again, within 60s on the
  droplet. No special handling.
- **An `owner` that names no user** is ignored, with one warning at load or
  reload.
- **Logging:** one line when a user becomes paused and one when they're back,
  never one per refused request.

## Left to the builder

- Whether `owner` is copied onto the runtime account object (`makeAccount`,
  plus reload) or read from `config.accounts` live. Either way, a reload must
  apply it.
- How the pause/unpause log lines detect the transition.

## Testing and rollout

- Unit tests for the helper: admin exempt, no seat, unknown owner, several
  seats, hand ban wins.
- Each of the five gates refuses a paused user and lets them back in once the
  seat's status returns to `active`.
- `owner` survives re-login and save. The dashboard users payload carries the
  flag.
- Tests run on `hetzner-iddhi` (rsync to `/root/work/teamclaude/`), never on
  the laptop.
- Rollout, each step after asking: deploy to the droplet, back up
  `/root/.config/teamclaude.json`, write the `owner` fields through
  `atomicConfigUpdate`, then POST `/teamclaude/reload`. Leave Ruchira's
  in-progress re-login and his key state to the session handling it.
