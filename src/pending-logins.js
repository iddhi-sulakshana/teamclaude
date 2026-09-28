// Dashboard logins in flight: what each sign-in link the dashboard handed out
// needs when its code is pasted back — above all the PKCE verifier, which
// never leaves the server. The page only ever holds the link and its state,
// so a code read off someone's screen is useless to anyone but this process.
//
// Bounded three ways, because every entry is one POST away: a link lapses
// after `ttlMs`, the table keeps at most `max` of them (the oldest goes first),
// and each allows `attempts` pastes. A mistyped code costs one attempt rather
// than the link — the verifier is still good, and upstream itself refuses a
// code it has already redeemed.

export const PENDING_LOGIN_TTL_MS = 15 * 60 * 1000;
export const PENDING_LOGIN_MAX = 8;
export const PENDING_LOGIN_ATTEMPTS = 5;

/**
 * @typedef {{ url: string, state: string, codeVerifier: string, redirectUri: string }} Login
 * @typedef {Login & { expiresAt: number, attemptsLeft: number }} PendingLogin
 */

export class PendingLogins {
  /**
   * @param {{ now?: () => number, ttlMs?: number, max?: number, attempts?: number }} [opts]
   */
  constructor({ now = () => Date.now(), ttlMs = PENDING_LOGIN_TTL_MS, max = PENDING_LOGIN_MAX, attempts = PENDING_LOGIN_ATTEMPTS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.max = max;
    this.attempts = attempts;
    /** @type {Map<string, PendingLogin>} */
    this.pending = new Map();
  }

  /**
   * Hold a login until its code comes back, and answer what the page may see.
   * @param {Login} login
   * @returns {{ url: string, state: string, expiresAt: number }}
   */
  add(login) {
    this.sweep();
    // Map order is insertion order, so the first key is the oldest link.
    while (this.pending.size >= this.max) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(login.state, { ...login, expiresAt, attemptsLeft: this.attempts });
    return { url: login.url, state: login.state, expiresAt };
  }

  /**
   * Spend one attempt on a login, or null when there is none to spend: never
   * started here, lapsed, finished, or out of attempts. The last attempt
   * removes the entry, so whatever happens to it, no sixth one exists.
   * @param {unknown} state
   * @returns {PendingLogin|null}
   */
  use(state) {
    this.sweep();
    if (typeof state !== 'string') return null;
    const entry = this.pending.get(state);
    if (!entry) return null;
    entry.attemptsLeft -= 1;
    if (entry.attemptsLeft <= 0) this.pending.delete(state);
    return entry;
  }

  /** A login that succeeded is gone: its code is spent upstream anyway.
   * @param {string} state */
  done(state) {
    this.pending.delete(state);
  }

  sweep() {
    const now = this.now();
    for (const [state, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(state);
    }
  }
}
