// Per-client usage accounting (proxy.clientKeys).
//
// One shared proxy.apiKey means every consumer of a team proxy looks the same:
// the per-account usage the account manager keeps says WHAT was spent, never by
// WHOM. `proxy.clientKeys` gives each consumer their own key + name; the auth
// gates report which entry matched, and the tokens each response reports are
// then booked against that name — per-CLIENT accounting alongside the existing
// per-ACCOUNT accounting, fed by the same response parsing.
//
// The tracker itself is deliberately dumb: a name → counters map. Identity
// resolution (which key matched) lives in the auth gates (server.js / mitm.js);
// token extraction stays where it always was (server.js). This file only
// aggregates, so it can be tested — and reasoned about — in isolation.
//
// Attribution is best-effort by design: loopback traffic that presents no key
// is exempt from the gate and therefore unattributed, as is anything using the
// single shared proxy.apiKey. Deployments that want complete per-client stats
// give every consumer a clientKeys entry and treat the shared key as legacy.
//
// A WebSocket handshake (Remote Control's real-time channel) is booked as a
// `connection`, apart from the request counters: it is not a request and
// carries no tokens, so folding it into `requests` would misstate the usage
// totals — but "which clients open channels here" is a question the same
// table answers (#325).

export const DEFAULT_USAGE_DIMENSION_MAX_KEYS = 500;
export const USAGE_DIMENSION_VALUE_MAX_LENGTH = 200;

// Where usage lands once a tracker is at its key cap. The counters are
// persisted and cumulative, so the cap must never delete a row: evicting the
// least-recently-used one means a burst of distinct values silently erases
// lifetime totals for the values that matter, and the periodic save makes that
// permanent. Folding into one bucket keeps the sum honest and says so in the
// output. A caller whose value is literally `(other)` merges with it — harmless,
// and preferable to a sentinel that no value could ever collide with but that
// also could not be typed by an operator reading the docs.
export const OVERFLOW_KEY = '(other)';

// Windowed usage.
//
// The counters above are lifetime: they answer "how much has this client ever
// spent" and cannot answer "how much in the last day", because nothing records
// WHEN a token was spent. A per-slot tally does, at a bounded cost. Traffic
// lands in the 15-minute slot it arrived in, and a slot that has fallen out of
// the longest window is deleted rather than kept, so the cost is set by the
// window and not by uptime. Slots are sparse — a key seen twice a day holds two
// of them, not ninety-six — which is what keeps this affordable for a dimension
// tracker holding up to `maxKeys` distinct values.
export const USAGE_SLOT_MS = 15 * 60 * 1000;

// The windows rolled up for readers, shortest first. `5h` is the shared quota
// window, so it says what is being spent against the bucket that gates the next
// request; `24h` is the day-scale question an operator actually asks. A 7-day
// rolling window is deliberately absent: the weekly quota is a bucket with a
// reset instant, not a rolling window, so the honest weekly number is "since
// the reset" and would be a baseline, not a tally like this one.
export const USAGE_WINDOWS = { '5h': 5 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 };

// Retention is the longest window plus one slot. A window's start falls inside
// a slot rather than on its edge, so that oldest slot is only partly covered:
// keeping it overstates the window by less than one slot, dropping it would
// understate it by the same amount, and overstating is the safer of the two for
// a number an operator reads to decide whether they are near a limit.
const RETAINED_SLOTS = Math.ceil(Math.max(...Object.values(USAGE_WINDOWS)) / USAGE_SLOT_MS) + 1;

// The calendar month, on the server's clock: everything since the 1st, reset
// when the month turns. It is not a rolling span, so it is not in
// USAGE_WINDOWS and is not tallied in slots — a month of 15-minute slots is
// 3,000 rows a key — but in a day tally of its own, one row per calendar day
// with traffic, holding only the current month's days. Extra usage bills by
// calendar month, which is why this is the month offered rather than a
// rolling thirty days.
export const USAGE_MONTH = 'month';

// Every window a `windows` rollup carries, shortest first.
export const USAGE_WINDOW_LABELS = [...Object.keys(USAGE_WINDOWS), USAGE_MONTH];

const pad2 = (/** @type {number} */ n) => (n < 10 ? '0' : '') + n;

/** The calendar day `ms` falls on, on the server's clock, as `YYYY-MM-DD`. @param {number} ms */
export function usageDayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @typedef {{ requests: number, connections: number, inputTokens: number, outputTokens: number }} UsageCounters */
/** @typedef {UsageCounters & { lastUsed: number | null, slots: Map<number, UsageCounters>, days: Map<string, UsageCounters> }} ClientRecord */

const RESERVED_CUSTOM_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-app',
  'x-claude-code-session-id',
  'x-claude-code-agent-id',
  'x-claude-code-parent-agent-id',
  'x-anthropic-additional-protection',
]);

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i;
const DIMENSION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class ClientUsageTracker {
  // `maxKeys` stays unbounded for per-client accounting — clientKeys is
  // operator-configured, so the key space is bounded by the config file. It is
  // set only for the header-derived dimension trackers, whose values come from
  // callers and are therefore unbounded.
  constructor({ now = () => Date.now(), maxKeys = Infinity } = {}) {
    // name → { requests, connections, inputTokens, outputTokens, lastUsed(ms),
    //          slots: Map<slotNumber, { requests, connections, inputTokens, outputTokens }>,
    //          days: Map<'YYYY-MM-DD', { requests, connections, inputTokens, outputTokens }> }
    this.clients = new Map();
    this._now = now;
    this.maxKeys = maxKeys;
  }

  _ensure(name) {
    let c = this.clients.get(name);
    if (!c) {
      if (this.clients.size >= this.maxKeys && name !== OVERFLOW_KEY) return this._ensure(OVERFLOW_KEY);
      c = { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0, lastUsed: null, slots: new Map(), days: new Map() };
      this.clients.set(name, c);
    }
    return c;
  }

  /** Book usage against a client name. A null/empty name is dropped (unattributed). */
  record(name, { requests = 0, connections = 0, inputTokens = 0, outputTokens = 0 } = {}) {
    if (!name) return;
    const c = this._ensure(name);
    c.requests += requests;
    c.connections += connections;
    c.inputTokens += inputTokens;
    c.outputTokens += outputTokens;
    c.lastUsed = this._now();
    // Eviction runs only when this write opens a new slot, and against the
    // same clock reading as lastUsed: a second read of the clock could land
    // past a slot boundary and evict the oldest slot the windows still cover.
    const slotNo = Math.floor(c.lastUsed / USAGE_SLOT_MS);
    const opening = !c.slots.has(slotNo);
    const slot = this._slotFor(c, slotNo);
    if (opening) this._evict(c, c.lastUsed);
    const day = this._dayFor(c, usageDayKey(c.lastUsed));
    for (const tally of [slot, day]) {
      tally.requests += requests;
      tally.connections += connections;
      tally.inputTokens += inputTokens;
      tally.outputTokens += outputTokens;
    }
  }

  /**
   * Drop every slot now outside retention. Runs both when a key opens a new
   * slot and when a key is read out, and needs both: eviction on write alone
   * never runs for a key that has stopped recording, and a dimension keyed on
   * something like a git ref is mostly keys that went silent for good. Those
   * would hold their slots for as long as the process ran, making the cost a
   * function of every distinct key seen since the last restart rather than of
   * the window. So a read prunes too — unusual, but the slots it drops are
   * outside every window and can never be reported again, and the alternative
   * is a timer this file does not have. In practice the reads come on a
   * schedule anyway: the once-a-minute state save in index.js
   * (persistQuotaState → exportState) prunes every key it writes out.
   * @param {ClientRecord} c
   * @param {number} now
   */
  _evict(c, now) {
    const cutoff = Math.floor(now / USAGE_SLOT_MS) - RETAINED_SLOTS;
    // Deleting during iteration is defined for a Map: an entry removed before
    // it is reached is simply never visited.
    for (const slot of c.slots.keys()) if (slot <= cutoff) c.slots.delete(slot);
    // A day from an earlier month is out of the month window for good. A day
    // ahead of today is kept: it is a clock that stepped back, which restore
    // refuses and a live run cannot produce, and it ages back in.
    const month = usageDayKey(now).slice(0, 7);
    for (const day of c.days.keys()) if (day.slice(0, 7) < month) c.days.delete(day);
  }

  /**
   * The day tally for `key`, created on first use.
   * @param {ClientRecord} c
   * @param {string} key
   * @returns {UsageCounters}
   */
  _dayFor(c, key) {
    let tally = c.days.get(key);
    if (!tally) c.days.set(key, tally = { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 });
    return tally;
  }

  /**
   * The tally for `slot`, created on first use. Creation alone does not evict:
   * record() does that when a live write opens a slot, and restore bounds what
   * it admits up front — running a full eviction walk from here made a restore
   * of n slots cost n walks over a growing map.
   * @param {ClientRecord} c
   * @param {number} slot
   * @returns {UsageCounters}
   */
  _slotFor(c, slot) {
    let tally = c.slots.get(slot);
    if (!tally) c.slots.set(slot, tally = { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 });
    return tally;
  }

  /**
   * One client's counters rolled up per window in USAGE_WINDOWS. A window
   * covers its own length plus at most one slot — see RETAINED_SLOTS. Every
   * window is present here, zeros included; whether the set is reported at all
   * is export()'s decision, not this one's.
   * @param {ClientRecord} c
   * @param {number} now
   * @returns {Record<string, UsageCounters>}
   */
  _windows(c, now) {
    /** @type {Record<string, UsageCounters>} */
    const out = {};
    // Cutoffs first, then ONE walk of the slots: this runs per key on every
    // status poll, and the fastest poller in the tree asks once a second.
    /** @type {Array<[number, UsageCounters]>} */
    const cutoffs = [];
    for (const [label, span] of Object.entries(USAGE_WINDOWS)) {
      out[label] = { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 };
      cutoffs.push([Math.floor((now - span) / USAGE_SLOT_MS), out[label]]);
    }
    for (const [slot, t] of c.slots) {
      for (const [from, sum] of cutoffs) {
        if (slot < from) continue;
        sum.requests += t.requests;
        sum.connections += t.connections;
        sum.inputTokens += t.inputTokens;
        sum.outputTokens += t.outputTokens;
      }
    }
    const month = out[USAGE_MONTH] = { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 };
    const today = usageDayKey(now);
    for (const [day, t] of c.days) {
      if (day.slice(0, 7) !== today.slice(0, 7) || day > today) continue;
      month.requests += t.requests;
      month.connections += t.connections;
      month.inputTokens += t.inputTokens;
      month.outputTokens += t.outputTokens;
    }
    return out;
  }

  /**
   * Plain-object snapshot for /teamclaude/status and the dashboard (lastUsed as
   * ISO string, matching how the status endpoint reports times), carrying the
   * rolled-up windows rather than the slots they were summed from: a reader
   * wants two figures per client, and the tally behind them is up to a hundred
   * rows that the dashboard would have to re-sum on every poll.
   */
  export() {
    const now = this._now();
    return this._snapshot(now, c => {
      const windows = this._windows(c, now);
      // Omitted entirely for a key with nothing in any window, rather than
      // shipped as rows of zeros. The rolling windows nest, but the month need
      // not hold the last 24 hours (on the 1st it holds only today), so
      // "empty" is checked across every window rather than the longest. On a
      // dimension carrying a value per git ref, most keys are old
      // branches that are silent for good, and they were the bulk of the
      // payload. A reader that finds no `windows` reads zero for every window,
      // which is what the absence means.
      return Object.values(windows).some(w => w.requests || w.connections || w.inputTokens || w.outputTokens)
        ? { windows }
        : {};
    });
  }

  /**
   * Every client's traffic over the last day as a time series, for the
   * dashboard's usage-over-time chart: `buckets` consecutive buckets of
   * `slotsPerBucket` slots each, oldest first, the last one ending with the
   * slot the clock is in now. A bucket is a whole number of slots because the
   * slots are all that is kept — nothing finer can be reported, and a bucket
   * cut through a slot would have to guess how its traffic divided. Bucket `i`
   * covers [end - (buckets - i) * bucketMs, end - (buckets - 1 - i) * bucketMs).
   *
   * Asking for more history than retention holds returns only what is held
   * rather than a run of zeros, which would read as "idle" when it means
   * "not kept". A client with nothing in any bucket is left out, as export()
   * leaves out one with nothing in any window.
   * @param {{ buckets?: number, slotsPerBucket?: number }} [opts]
   */
  series({ buckets = 24, slotsPerBucket = 4 } = {}) {
    const now = this._now();
    const per = Math.max(1, Math.floor(slotsPerBucket));
    const n = Math.max(0, Math.min(Math.floor(buckets), Math.floor(RETAINED_SLOTS / per)));
    const current = Math.floor(now / USAGE_SLOT_MS);
    const first = current - n * per + 1;
    const zeros = () => new Array(n).fill(0);
    // Null prototype for the reason _snapshot() gives: a client named
    // `__proto__` must come out as an own key.
    const clients = Object.create(null);
    for (const [name, c] of this.clients) {
      this._evict(c, now);
      /** @type {{ requests: number[], inputTokens: number[], outputTokens: number[] } | null} */
      let row = null;
      for (const [slot, t] of c.slots) {
        if (slot < first || slot > current) continue;
        if (!(t.requests || t.inputTokens || t.outputTokens)) continue;
        if (!row) row = { requests: zeros(), inputTokens: zeros(), outputTokens: zeros() };
        const i = Math.floor((slot - first) / per);
        row.requests[i] += t.requests;
        row.inputTokens[i] += t.inputTokens;
        row.outputTokens[i] += t.outputTokens;
      }
      if (row) clients[name] = row;
    }
    return {
      slotMs: USAGE_SLOT_MS,
      bucketMs: per * USAGE_SLOT_MS,
      buckets: n,
      end: (current + 1) * USAGE_SLOT_MS,
      clients: Object.fromEntries(Object.entries(clients)),
    };
  }

  /**
   * The current calendar month by day, for the dashboard's charts under This
   * month: `days` lists the month's days from the 1st through today, as
   * `YYYY-MM-DD` on the server's clock, and each client carries a `requests`,
   * `inputTokens` and `outputTokens` array of that length. Days are named
   * rather than measured from an `end`: a day is not always 24 hours across a
   * clock change, and the page labels a day by its date, not by an instant.
   * A client with nothing this month is left out, as series() leaves one out.
   */
  monthSeries() {
    const now = this._now();
    const today = new Date(now);
    /** @type {string[]} */
    const days = [];
    for (let d = 1; d <= today.getDate(); d++) days.push(usageDayKey(new Date(today.getFullYear(), today.getMonth(), d, 12).getTime()));
    const index = new Map(days.map((day, i) => [day, i]));
    const zeros = () => new Array(days.length).fill(0);
    const clients = Object.create(null);
    for (const [name, c] of this.clients) {
      this._evict(c, now);
      /** @type {{ requests: number[], inputTokens: number[], outputTokens: number[] } | null} */
      let row = null;
      for (const [day, t] of c.days) {
        const i = index.get(day);
        if (i === undefined || !(t.requests || t.inputTokens || t.outputTokens)) continue;
        if (!row) row = { requests: zeros(), inputTokens: zeros(), outputTokens: zeros() };
        row.requests[i] += t.requests;
        row.inputTokens[i] += t.inputTokens;
        row.outputTokens[i] += t.outputTokens;
      }
      if (row) clients[name] = row;
    }
    return { span: USAGE_MONTH, days, buckets: days.length, clients: Object.fromEntries(Object.entries(clients)) };
  }

  /**
   * Snapshot for the state file. Carries the slots instead of the windows, so a
   * restart resumes the windows rather than restarting them — an upgrade is
   * exactly when someone looks at the dashboard, and a 24h figure that reads
   * zero after every deploy is worse than not offering one.
   */
  exportState() {
    // An empty `slots` is left out for the same reason `export()` leaves out an
    // empty `windows`: at the key cap the stale rows are most of them.
    return this._snapshot(this._now(), c => ({
      ...(c.slots.size ? { slots: Object.fromEntries(c.slots) } : {}),
      ...(c.days.size ? { days: Object.fromEntries(c.days) } : {}),
    }));
  }

  // `now` is passed in rather than read here, so that a caller which also uses
  // it — export() rolls the windows up against it — cannot have eviction run
  // against a second, later instant. Two reads straddling a slot boundary would
  // evict exactly the oldest slot the rollup still reads.
  /** @param {number} now @param {(c: ClientRecord) => Record<string, unknown>} extra */
  _snapshot(now, extra) {
    // Built on a null prototype and copied out with fromEntries, so a name like
    // `__proto__` lands as an own key of a plain object instead of on its
    // prototype (names are operator-configured, but the cost of getting this
    // wrong is silent loss of the row).
    const out = Object.create(null);
    for (const [name, c] of this.clients) {
      this._evict(c, now);
      out[name] = {
        requests: c.requests,
        connections: c.connections,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        lastUsed: c.lastUsed ? new Date(c.lastUsed).toISOString() : null,
        ...extra(c),
      };
    }
    return Object.fromEntries(Object.entries(out));
  }

  /**
   * Restore a snapshot saved by a previous run. Adds onto anything already
   * recorded (restore runs at startup, but being additive means a late restore
   * can never erase live traffic). Malformed entries are skipped, not fatal —
   * the state file is documented as safe to delete, so it must also be safe to
   * hand-edit badly.
   */
  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    for (const [name, s] of Object.entries(saved)) {
      if (!name || !s || typeof s !== 'object') continue;
      const c = this._ensure(name);
      c.requests += Number(s.requests) || 0;
      c.connections += Number(s.connections) || 0;
      c.inputTokens += Number(s.inputTokens) || 0;
      c.outputTokens += Number(s.outputTokens) || 0;
      const t = s.lastUsed ? Date.parse(s.lastUsed) : NaN;
      if (!Number.isNaN(t) && (c.lastUsed == null || t > c.lastUsed)) c.lastUsed = t;
      const slots = this._restoreSlots(c, s.slots);
      // A snapshot from a build without the day tally carries no `days` at
      // all. Its slots still hold the last day, so the month starts from them
      // rather than from zero — every slot restored is one the month window
      // covers, if it fell in this month. A snapshot that has `days`, even
      // empty, already holds those slots there too.
      if (s.days === undefined) {
        const month = usageDayKey(this._now()).slice(0, 7);
        for (const [slot, t] of slots) {
          const day = usageDayKey(slot * USAGE_SLOT_MS);
          if (day.slice(0, 7) !== month) continue;
          const tally = this._dayFor(c, day);
          tally.requests += t.requests;
          tally.connections += t.connections;
          tally.inputTokens += t.inputTokens;
          tally.outputTokens += t.outputTokens;
        }
      } else this._restoreDays(c, s.days);
    }
  }

  /**
   * Days from a saved snapshot, added onto whatever is already tallied for the
   * same day. Only this month's days up to today are admitted: an earlier
   * month is outside the window for good, and a day ahead of today is a clock
   * that moved backwards, for the reason _restoreSlots() refuses a future slot.
   * @param {ClientRecord} c
   * @param {unknown} saved
   */
  _restoreDays(c, saved) {
    if (!saved || typeof saved !== 'object') return;
    const today = usageDayKey(this._now());
    for (const [key, t] of Object.entries(saved)) {
      if (!DAY_KEY_RE.test(key) || key.slice(0, 7) !== today.slice(0, 7) || key > today || !t || typeof t !== 'object') continue;
      const tally = this._dayFor(c, key);
      tally.requests += Number(t.requests) || 0;
      tally.connections += Number(t.connections) || 0;
      tally.inputTokens += Number(t.inputTokens) || 0;
      tally.outputTokens += Number(t.outputTokens) || 0;
    }
  }

  /**
   * Slots from a saved snapshot, added onto whatever is already tallied for the
   * same slot. Anything already outside retention is dropped here rather than
   * left for the next write: a proxy that was down for a week would otherwise
   * restore a full set of dead slots and report them as current until its next
   * request. A snapshot from a build that did not keep slots simply has none,
   * and the windows then fill from live traffic. This is also the only place a
   * slot ahead of the clock is refused: a backwards clock step during a run is
   * not caught until the next restart.
   * Returns each slot it admitted with the counters it added, so restore()
   * can seed the day tally from a snapshot that has none.
   * @param {ClientRecord} c
   * @param {unknown} saved
   * @returns {Array<[number, UsageCounters]>}
   */
  _restoreSlots(c, saved) {
    /** @type {Array<[number, UsageCounters]>} */
    const admitted = [];
    if (!saved || typeof saved !== 'object') return admitted;
    const current = Math.floor(this._now() / USAGE_SLOT_MS);
    const oldest = current - RETAINED_SLOTS;
    for (const [key, t] of Object.entries(saved)) {
      const slot = Number(key);
      // Bounded at BOTH ends. A slot ahead of the clock cannot be a real
      // observation of the past — it is a snapshot written before the clock
      // moved backwards — and admitting one would leave it counting in every
      // window until the clock caught up with it.
      if (!Number.isInteger(slot) || slot <= oldest || slot > current || !t || typeof t !== 'object') continue;
      const tally = this._slotFor(c, slot);
      const add = {
        requests: Number(t.requests) || 0,
        connections: Number(t.connections) || 0,
        inputTokens: Number(t.inputTokens) || 0,
        outputTokens: Number(t.outputTokens) || 0,
      };
      tally.requests += add.requests;
      tally.connections += add.connections;
      tally.inputTokens += add.inputTokens;
      tally.outputTokens += add.outputTokens;
      admitted.push([slot, add]);
    }
    return admitted;
  }
}

/**
 * The same accounting, one tracker per operator-configured dimension.
 *
 * `proxy.clientKeys` answers "who spent this" for a consumer that holds a key.
 * It cannot answer "on what" — one CI key covers every repository it builds.
 * A dimension maps a request header to a counter set, so a caller can label its
 * own traffic (project, ref, team) through ANTHROPIC_CUSTOM_HEADERS without the
 * operator issuing a key per label.
 *
 * Only configured dimensions exist. Per-session cost is NOT a dimension here:
 * SessionTracker already meters it from the response usage, cache tokens
 * included, which is the number that matters — an `input_tokens` sum
 * understates a cached session by orders of magnitude.
 */
export class UsageDimensionTracker {
  constructor({ now = () => Date.now(), maxKeys = DEFAULT_USAGE_DIMENSION_MAX_KEYS } = {}) {
    this._now = now;
    this._dimensions = new Map();
    this._maxKeys = maxKeys;
  }

  _tracker(name) {
    const key = normalizeDimensionName(name);
    if (!key) return null;
    let tracker = this._dimensions.get(key);
    if (!tracker) {
      tracker = new ClientUsageTracker({ now: this._now, maxKeys: this._maxKeys });
      this._dimensions.set(key, tracker);
    }
    return tracker;
  }

  record(dimension, key, usage) {
    const tracker = this._tracker(dimension);
    if (!tracker || !key) return;
    tracker.record(key, usage);
  }

  export() {
    return this._snapshot(tracker => tracker.export());
  }

  /** The state-file form, carrying slots. See ClientUsageTracker.exportState(). */
  exportState() {
    return this._snapshot(tracker => tracker.exportState());
  }

  /** @param {(tracker: ClientUsageTracker) => Record<string, unknown>} pick */
  _snapshot(pick) {
    // Null prototype for the same reason ClientUsageTracker.export() uses one:
    // a dimension named `__proto__` must land as an own key, not silently
    // vanish onto the prototype.
    const out = Object.create(null);
    for (const [name, tracker] of this._dimensions) {
      const entries = pick(tracker);
      if (Object.keys(entries).length) out[name] = entries;
    }
    return Object.fromEntries(Object.entries(out));
  }

  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    for (const [name, entries] of Object.entries(saved)) {
      const tracker = this._tracker(name);
      if (tracker) tracker.restore(entries);
    }
  }
}

/**
 * The dimensions one request contributes to: `[{ name, key }]`, empty when
 * nothing is configured or no configured header was sent. Read from
 * `proxy.usageDimensions` live per request, so a config reload applies to a
 * running server the way clientKeys does.
 */
export function resolveUsageDimensions(proxyConfig, headers = {}) {
  const out = [];
  const configured = Array.isArray(proxyConfig?.usageDimensions) ? proxyConfig.usageDimensions : [];
  for (const entry of configured) {
    const name = normalizeDimensionName(entry?.name);
    const header = normalizeUsageHeaderName(entry?.header);
    if (!name || !header) continue;
    const value = sanitizeUsageDimensionValue(headers[header]);
    if (value) out.push({ name, key: value });
  }
  return out;
}

/**
 * The header names configured as dimensions, lowercased — what to strip before
 * forwarding upstream. An entry is only counted when BOTH its name and header
 * are valid, so this stays exactly the set resolveUsageDimensions() reads: a
 * header the proxy does not consume is not the proxy's to remove.
 */
export function usageDimensionHeaderNames(proxyConfig) {
  const out = new Set();
  const configured = Array.isArray(proxyConfig?.usageDimensions) ? proxyConfig.usageDimensions : [];
  for (const entry of configured) {
    const header = normalizeUsageHeaderName(entry?.header);
    if (header && normalizeDimensionName(entry?.name)) out.add(header);
  }
  return out;
}

export function createUsageRecorder({ client, clientUsage, dimensions, dimensionUsage }) {
  const targets = [];
  if (client && clientUsage) targets.push({ tracker: clientUsage, key: client });
  if (dimensionUsage) {
    for (const dimension of dimensions || []) {
      targets.push({ tracker: dimensionUsage, dimension: dimension.name, key: dimension.key });
    }
  }
  if (!targets.length) return { recordRequest: () => {}, onUsage: null };
  return {
    recordRequest() {
      for (const target of targets) {
        if (target.dimension) target.tracker.record(target.dimension, target.key, { requests: 1 });
        else target.tracker.record(target.key, { requests: 1 });
      }
    },
    onUsage(inputTokens, outputTokens) {
      for (const target of targets) {
        if (target.dimension) target.tracker.record(target.dimension, target.key, { inputTokens, outputTokens });
        else target.tracker.record(target.key, { inputTokens, outputTokens });
      }
    },
  };
}

function normalizeDimensionName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return DIMENSION_NAME_RE.test(name) ? name : null;
}

// A configured header must be a valid token, and must not be one the proxy or
// the client already relies on: a dimension is operator config, but pointing one
// at `authorization` or `cookie` would copy a credential into a persisted,
// status-visible counter name.
function normalizeUsageHeaderName(value) {
  if (typeof value !== 'string') return null;
  const header = value.trim().toLowerCase();
  if (!header || !HEADER_NAME_RE.test(header)) return null;
  if (RESERVED_CUSTOM_HEADER_NAMES.has(header)) return null;
  return header;
}

/**
 * Header values reach a terminal renderer and a JSON status payload, so control
 * characters and escape sequences are stripped at ingest rather than at every
 * point of display, and the result is length-capped.
 */
export function sanitizeUsageDimensionValue(value, { maxLength = USAGE_DIMENSION_VALUE_MAX_LENGTH } = {}) {
  if (Array.isArray(value)) value = value.join(', ');
  if (typeof value !== 'string') return null;
  const sanitized = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return null;
  return sanitized.length > maxLength ? sanitized.slice(0, maxLength) : sanitized;
}
