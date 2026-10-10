import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  explainDigest, explainSpawnSpec, runCapture, ForecastExplainer, ExplainError,
  EXPLAIN_TTL_MS, EXPLAIN_MAX_CHARS,
} from '../src/forecast-explain.js';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const FORECAST = {
  generatedAt: NOW, bucket: 'weekly', confidence: 'high', spanHours: 24, strategy: 'soonest-reset', notForecast: [],
  reason: null, burnRate: 0.2, pace: 1.4, verdict: 'overusing', threshold: 0.98, fleetCapacity: 20,
  poolDryAt: NOW + 41 * HOUR, dryForMs: 30 * HOUR, unusedPct: 0,
  accounts: [{ name: 'a@x', weight: 20, u: 0.71, reset: NOW + 71 * HOUR, drainsAt: NOW + 31 * HOUR, unusedAtReset: null, sessionHitsAt: null }],
  users: [{ name: 'alice', spent: 1, share: 0.48, fairShareX: 2.1, heavy: true, withoutThemDryAt: null }],
  scoped: [{ bucket: 'fable', verdict: 'on-pace', pace: 0.6, poolDryAt: null, unusedPct: 12 }],
  series: { past: [[NOW, 0.5]], projected: [[NOW, 0.5]] },
};

test('the digest turns times into hours and fractions into percentages', () => {
  const d = explainDigest(FORECAST);
  assert.equal(d.verdict, 'overusing');
  assert.equal(d.poolDryInHours, 41);
  assert.equal(d.dryForHours, 30);
  assert.deepEqual(d.accounts[0], { name: 'a@x', tierWeight: 20, weeklyUsedPct: 71, resetsInHours: 71, drainsInHours: 31, unusedAtResetPct: null });
  assert.deepEqual(d.users[0], { name: 'alice', shareOfLast24hPct: 48, timesFairShare: 2.1, heavy: true, poolDryInHoursWithoutThem: null });
  assert.deepEqual(d.modelCaps[0], { model: 'fable', verdict: 'on-pace', pace: 0.6, poolDryInHours: null, unusedAtResetsPct: 12 });
  assert.equal('series' in d, false, 'the curves are for the chart, not the model');
});

test('the spawn spec runs bare claude -p on haiku against this proxy with the caller\'s key', () => {
  const spec = explainSpawnSpec({ port: 3456, apiKey: 'tc-alice', forecast: FORECAST });
  assert.equal(spec.command, 'claude');
  assert.deepEqual(spec.args.slice(0, 6), ['-p', '--bare', '--model', 'haiku', '--output-format', 'text']);
  assert.equal(spec.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456');
  assert.equal(spec.env.ANTHROPIC_API_KEY, 'tc-alice');
  assert.deepEqual(JSON.parse(spec.input), explainDigest(FORECAST));
});

function explainer(run, { now = () => NOW, fallbackKey = () => 'tc-shared' } = {}) {
  return new ForecastExplainer({ port: 3456, run, now, fallbackKey });
}

test('an answer is cleaned, capped and cached for fifteen minutes', async () => {
  let clock = NOW;
  const specs = [];
  const run = async spec => { specs.push(spec); return { code: 0, stdout: 'Overusing.\n\x1b[2JAct now.' + 'x'.repeat(3000), stderr: '' }; };
  const ex = explainer(run, { now: () => clock });
  const first = await ex.explain(FORECAST, 'tc-alice');
  assert.equal(first.cached, false);
  assert.equal(first.generatedAt, NOW);
  assert.ok(first.text.startsWith('Overusing. Act now.'), first.text.slice(0, 30));
  assert.equal(first.text.length, EXPLAIN_MAX_CHARS);
  assert.equal(specs[0].env.ANTHROPIC_API_KEY, 'tc-alice');
  clock += EXPLAIN_TTL_MS - 1;
  assert.equal((await ex.explain(FORECAST, 'tc-bob')).cached, true);
  assert.equal(specs.length, 1);
  clock += 2;
  assert.equal((await ex.explain(FORECAST, null)).cached, false, 'expired, asked again');
  assert.equal(specs[1].env.ANTHROPIC_API_KEY, 'tc-shared', 'no caller key: the fallback');
});

test('concurrent asks share one run', async () => {
  let runs = 0;
  let release;
  const run = () => { runs++; return new Promise(resolve => { release = () => resolve({ code: 0, stdout: 'Shared.', stderr: '' }); }); };
  const ex = explainer(run);
  const a = ex.explain(FORECAST, 'k1');
  const b = ex.explain(FORECAST, 'k2');
  release();
  assert.deepEqual(await a, await b);
  assert.equal(runs, 1);
});

test('failures become readable ExplainErrors and are not cached', async () => {
  const cases = [
    [async () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); }, 503, /not found on the server/],
    [async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); }, 502, /did not answer within 90 seconds/],
    [async () => ({ code: 1, stdout: '', stderr: 'warming\nInvalid API key\n' }), 502, /^Claude Code CLI failed: Invalid API key$/],
    [async () => ({ code: 0, stdout: '  \n', stderr: '' }), 502, /answered with nothing/],
  ];
  for (const [run, status, message] of cases) {
    const ex = explainer(run);
    await assert.rejects(ex.explain(FORECAST), err => err instanceof ExplainError && err.status === status && message.test(err.message));
    await assert.rejects(ex.explain(FORECAST), ExplainError, 'a failure is asked again, not cached');
  }
});

test('runCapture feeds stdin, collects stdout and the exit code', async () => {
  const out = await runCapture({ command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], env: process.env, input: 'hello', timeoutMs: 10_000 });
  assert.deepEqual(out, { code: 0, stdout: 'hello', stderr: '' });
  const failed = await runCapture({ command: process.execPath, args: ['-e', 'console.error("bad"); process.exit(3)'], env: process.env, input: '', timeoutMs: 10_000 });
  assert.equal(failed.code, 3);
  assert.equal(failed.stderr.trim(), 'bad');
});

test('runCapture rejects a missing binary and kills a hung one', async () => {
  await assert.rejects(
    runCapture({ command: 'teamclaude-no-such-binary', args: [], env: process.env, input: '', timeoutMs: 10_000 }),
    err => err.code === 'ENOENT',
  );
  await assert.rejects(
    runCapture({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60_000)'], env: process.env, input: '', timeoutMs: 200 }),
    err => err.code === 'ETIMEDOUT',
  );
});
