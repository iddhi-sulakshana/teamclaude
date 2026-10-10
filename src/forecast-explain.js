// The forecast's "Explain": a few sentences from Haiku about what the numbers
// mean and what to do.
//
// It goes through the genuine Claude Code CLI pointed at THIS proxy — the same
// route the keep-warm feature takes (warmer.js) — because an OAuth subscription
// is for Claude Code, and a hand-built /v1/messages call would be the pattern
// docs/compliance.md warns against. It runs only when an operator clicks, so a
// human is in the loop, and the answer is cached for a quarter of an hour so a
// curious double-click does not spend twice.
//
// The model is shown a digest with times already turned into hours and
// fractions into percentages, and told to quote rather than calculate: every
// number on the page comes from forecast.js, never from the model.

import { spawn } from 'node:child_process';
import { sanitizeText, safeLine } from './safe-text.js';

export const EXPLAIN_MODEL = 'haiku';
export const EXPLAIN_TTL_MS = 15 * 60_000;
export const EXPLAIN_TIMEOUT_MS = 90_000;
export const EXPLAIN_MAX_CHARS = 2000;
/** More than any answer needs; a runaway child cannot grow the buffer past it. */
const MAX_CAPTURE = 64 * 1024;

export const EXPLAIN_INSTRUCTION = [
  'The JSON on stdin is a usage forecast for a team sharing a pool of Claude subscriptions through a proxy.',
  'Plan sizes are tier weights: Pro 1, Max 5x 5, Max 20x 20. pace 1.0 means spending exactly one week of capacity per week.',
  'A null time means it does not happen within the forecast (one week).',
  "In 3 to 5 plain sentences for the team's admin: say what is happening, name the main driver (an account or a user), and suggest one or two concrete actions.",
  'Quote only numbers that appear in the JSON; do not calculate new ones. No headings, no lists, no preamble.',
].join(' ');

/**
 * @typedef {import('./forecast-payload.js').ForecastPayload} ForecastPayload
 * @typedef {{ text: string, generatedAt: number, cached: boolean }} ExplainResult
 * @typedef {{ command: string, args: string[], env: NodeJS.ProcessEnv, input: string, timeoutMs: number }} SpawnSpec
 * @typedef {{ code: number, stdout: string, stderr: string }} Captured
 */

export class ExplainError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = 'ExplainError';
    this.status = status;
  }
}

/**
 * The forecast as the model is shown it: times as hours from now and fractions
 * as percentages, so the answer can quote figures instead of working them out.
 * The chart's curves are left out.
 * @param {ForecastPayload} f
 */
export function explainDigest(f) {
  const now = f.generatedAt;
  const hours = (/** @type {number|null|undefined} */ t) => (t == null ? null : Math.round((t - now) / 360_000) / 10);
  const pct = (/** @type {number|null|undefined} */ v) => (v == null ? null : Math.round(v * 1000) / 10);
  return {
    verdict: f.verdict,
    pace: f.pace,
    confidence: f.confidence,
    historyHours: f.spanHours,
    drainOrder: f.strategy,
    poolDryInHours: hours(f.poolDryAt),
    dryForHours: f.dryForMs == null ? null : Math.round(f.dryForMs / 360_000) / 10,
    unusedAtResetsPct: f.unusedPct,
    accounts: f.accounts.map(a => ({
      name: a.name, tierWeight: a.weight, weeklyUsedPct: pct(a.u), resetsInHours: hours(a.reset),
      drainsInHours: hours(a.drainsAt), unusedAtResetPct: pct(a.unusedAtReset),
    })),
    users: f.users.map(u => ({
      name: u.name, shareOfLast24hPct: pct(u.share), timesFairShare: u.fairShareX, heavy: u.heavy,
      ...('withoutThemDryAt' in u ? { poolDryInHoursWithoutThem: hours(u.withoutThemDryAt) } : {}),
    })),
    modelCaps: f.scoped.map(s => ({ model: s.bucket, verdict: s.verdict, pace: s.pace, poolDryInHours: hours(s.poolDryAt), unusedAtResetsPct: s.unusedPct })),
    notForecast: f.notForecast,
  };
}

/**
 * @param {{ port: number, apiKey: string|null, forecast: ForecastPayload }} opts
 * @returns {SpawnSpec}
 */
export function explainSpawnSpec({ port, apiKey, forecast }) {
  return {
    command: 'claude',
    // `--bare -p`: one non-interactive answer, authenticating strictly with
    // ANTHROPIC_API_KEY — which this proxy reads as the caller's key and swaps
    // for an account's token, as it does for every Claude Code request.
    args: ['-p', '--bare', '--model', EXPLAIN_MODEL, '--output-format', 'text', EXPLAIN_INSTRUCTION],
    env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: apiKey || 'tc-explain' },
    input: JSON.stringify(explainDigest(forecast)),
    timeoutMs: EXPLAIN_TIMEOUT_MS,
  };
}

/**
 * Run a command with `input` on its stdin and collect what it prints. Resolves
 * with the exit code and both streams; rejects when it cannot start (ENOENT for
 * a missing binary) or outlives `timeoutMs` (code ETIMEDOUT, after killing it).
 * @param {SpawnSpec} spec
 * @returns {Promise<Captured>}
 */
export function runCapture({ command, args, env, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
    let child;
    try {
      child = spawn(command, args, { env });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })));
    }, timeoutMs);
    timer.unref?.();
    /** @param {() => void} settle */
    const finish = settle => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (/** @type {string} */ chunk) => { if (stdout.length < MAX_CAPTURE) stdout += chunk; });
    child.stderr.on('data', (/** @type {string} */ chunk) => { if (stderr.length < MAX_CAPTURE) stderr += chunk; });
    child.once('error', err => finish(() => reject(err)));
    child.once('close', (code, signal) => finish(() => {
      if (signal) reject(new Error(`terminated by ${signal}`));
      else resolve({ code: code ?? 0, stdout, stderr });
    }));
    // A child that exits without reading closes the pipe under us; its exit
    // status is the report, not the EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** @param {string} text */
function lastLine(text) {
  const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
  return lines.length ? safeLine(lines[lines.length - 1], 200) : '';
}

export class ForecastExplainer {
  /**
   * @param {object} opts
   * @param {number} opts.port                       this proxy's port, which the CLI is pointed at
   * @param {() => string|null} [opts.fallbackKey]   the key when the caller presented none (proxy.apiKey)
   * @param {(spec: SpawnSpec) => Promise<Captured>} [opts.run]
   * @param {() => number} [opts.now]
   * @param {number} [opts.ttlMs]
   */
  constructor({ port, fallbackKey = () => null, run = runCapture, now = () => Date.now(), ttlMs = EXPLAIN_TTL_MS }) {
    this.port = port;
    this.fallbackKey = fallbackKey;
    this.run = run;
    this.now = now;
    this.ttlMs = ttlMs;
    /** @type {{ text: string, generatedAt: number }|null} */
    this.cached = null;
    /** @type {Promise<ExplainResult>|null} */
    this.inFlight = null;
  }

  /**
   * Explain `forecast`, or hand back the answer still fresh from the last ask.
   * Concurrent asks share one run.
   * @param {ForecastPayload} forecast
   * @param {string|null} [callerKey]
   * @returns {Promise<ExplainResult>}
   */
  explain(forecast, callerKey = null) {
    if (this.cached && this.now() - this.cached.generatedAt < this.ttlMs) return Promise.resolve({ ...this.cached, cached: true });
    if (!this.inFlight) this.inFlight = this._ask(forecast, callerKey).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /**
   * @param {ForecastPayload} forecast
   * @param {string|null} callerKey
   * @returns {Promise<ExplainResult>}
   */
  async _ask(forecast, callerKey) {
    /** @type {Captured} */
    let out;
    try {
      out = await this.run(explainSpawnSpec({ port: this.port, apiKey: callerKey || this.fallbackKey(), forecast }));
    } catch (err) {
      const e = /** @type {{ code?: string, message?: string }|null} */ (err);
      if (e && e.code === 'ENOENT') throw new ExplainError(503, 'Claude Code CLI not found on the server — install it there to use Explain');
      if (e && e.code === 'ETIMEDOUT') throw new ExplainError(502, `Claude did not answer within ${Math.round(EXPLAIN_TIMEOUT_MS / 1000)} seconds`);
      throw new ExplainError(502, 'Could not run the Claude Code CLI: ' + safeLine(e && e.message ? e.message : String(err), 200));
    }
    if (out.code !== 0) {
      throw new ExplainError(502, 'Claude Code CLI failed: ' + (lastLine(out.stderr) || lastLine(out.stdout) || `exit code ${out.code}`));
    }
    const text = sanitizeText(out.stdout).slice(0, EXPLAIN_MAX_CHARS);
    if (!text) throw new ExplainError(502, 'Claude Code CLI answered with nothing');
    this.cached = { text, generatedAt: this.now() };
    return { ...this.cached, cached: false };
  }
}
