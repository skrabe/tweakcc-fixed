import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { DEFAULT_SETTINGS } from '../src/defaultSettings.ts';
import { buildHybridRuntime } from '../src/patches/complexityRouterHybrid.ts';

type Turn = {
  message: string;
  allowed: [number, number];
  fixture: number;
  summary?: string;
  omitted?: boolean;
};
type Scenario = { id: string; domain: string; turns: Turn[] };
type Decision = {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};
type Result = {
  id: string;
  domain: string;
  turn: number;
  allowed: [number, number];
  rawLevel: number | null;
  effort: string | null;
  level: number | null;
  verdict: string;
  latencyMs: number;
  fallback: boolean;
  confidence: number | null;
  decision: unknown;
  probabilities: Record<string, number> | null;
  responseModel: string | null;
  requestBytes: number;
  request: unknown;
};
const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    replay: { type: 'string' },
    cases: { type: 'string', default: 'data/router-evals.json' },
    out: { type: 'string' },
    'runtime-file': { type: 'string' },
    'fixture-failure': { type: 'string' },
    'write-runtime': { type: 'string' },
    model: { type: 'string', default: 'claude-opus-5-5' },
    filter: { type: 'string' },
    repeat: { type: 'string', default: '1' },
  },
});
const config = {
  ...DEFAULT_SETTINGS.complexityRouter,
  enabled: true,
  provider: 'jev' as const,
  pinPerTask: false,
};
const source = values['runtime-file']
  ? await fs.readFile(values['runtime-file'], 'utf8')
  : buildHybridRuntime(
      config,
      { gB: 'summary', km: 'agentContext' },
      null,
      'require'
    );
if (values['write-runtime']) {
  await fs.writeFile(values['write-runtime'], source, { mode: 0o600 });
}
const corpus = JSON.parse(await fs.readFile(values.cases!, 'utf8')) as {
  cases: Scenario[];
};
const repeats = Number(values.repeat);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) {
  throw new Error('--repeat must be an integer between 1 and 20');
}
const cases = corpus.cases.filter(
  item => !values.filter || item.id.includes(values.filter)
);
if (!cases.length) throw new Error('No evaluation cases selected');
for (const item of cases) {
  if (!item.id || !item.turns.length)
    throw new Error('Invalid evaluation case');
  for (const turn of item.turns) {
    if (
      typeof turn.message !== 'string' ||
      !Array.isArray(turn.allowed) ||
      turn.allowed.length !== 2 ||
      !turn.allowed.every(
        value => Number.isInteger(value) && value >= 0 && value <= 3
      ) ||
      turn.allowed[0] > turn.allowed[1] ||
      !Number.isInteger(turn.fixture) ||
      turn.fixture < turn.allowed[0] ||
      turn.fixture > turn.allowed[1]
    )
      throw new Error(`Invalid turn in ${item.id}`);
  }
}
if (
  values['fixture-failure'] &&
  (values.live ||
    !['http', 'invalid', 'low-confidence'].includes(values['fixture-failure']))
) {
  throw new Error(
    '--fixture-failure requires offline mode and http, invalid, or low-confidence'
  );
}
if (values.replay && (values.live || values['fixture-failure'])) {
  throw new Error(
    '--replay cannot be combined with --live or --fixture-failure'
  );
}
const replay = values.replay
  ? (JSON.parse(await fs.readFile(values.replay, 'utf8')) as {
      model: string;
      results: Result[];
    })
  : null;
if (replay && replay.model !== values.model)
  throw new Error('Replay model does not match --model');
let requestMismatches = 0;
let activeRecorded: Result | undefined;
const require = createRequire(import.meta.url);
const results: Result[] = [];
for (let repeat = 0; repeat < repeats; repeat++) {
  for (const item of cases) {
    let active: Turn = item.turns[0];
    let request: unknown = null;
    let decision: Decision | undefined;
    let accepted = false;
    let responseModel: string | null = null;
    const logs: string[] = [];
    const context = vm.createContext({
      __tweakccRouterSelectedModel: () => values.model,
      Buffer,
      AbortController,
      setTimeout,
      clearTimeout,
      process: {
        platform: process.platform,
        env: values.live
          ? { ...process.env, TWEAKCC_ROUTER_DEBUG: '1' }
          : { TYPESAFE_API_KEY: 'offline-fixture', TWEAKCC_ROUTER_DEBUG: '1' },
        stderr: { write: (value: string) => logs.push(value) },
      },
      require: (id: string) => (id === 'fs' ? {} : require(id)),
      summary: async () => ({
        summary: active.summary || 'Synthetic evaluation context.',
      }),
      agentContext: () => ({}),
      fetch: async (url: string, init: RequestInit) => {
        request = JSON.parse(String(init.body));
        if (values['fixture-failure'] === 'http')
          return new Response('', { status: 503 });
        if (values['fixture-failure'] === 'invalid') return new Response('{}');
        if (
          activeRecorded &&
          JSON.stringify(activeRecorded.request) !== JSON.stringify(request)
        )
          requestMismatches++;
        const recordedResponse = activeRecorded
          ? new Response(
              JSON.stringify({
                model: activeRecorded.responseModel,
                answers: {
                  effort: {
                    type: 'choice',
                    choice: String(activeRecorded.rawLevel),
                    confidence: activeRecorded.confidence,
                    probabilities: activeRecorded.probabilities,
                  },
                },
              })
            )
          : null;
        const response =
          recordedResponse ||
          (values.live
            ? await fetch(url, init)
            : new Response(
                JSON.stringify({
                  answers: {
                    effort: {
                      type: 'choice',
                      choice: String(active.fixture),
                      confidence:
                        values['fixture-failure'] === 'low-confidence'
                          ? 0.2
                          : 0.97,
                      probabilities: Object.fromEntries(
                        config.levels.map((_, index) => [
                          String(index),
                          index === active.fixture ? 0.97 : 0.01,
                        ])
                      ),
                    },
                  },
                })
              ));
        if (response.ok) {
          const json = await response.clone().json();
          decision = json?.answers?.effort;
          responseModel = typeof json?.model === 'string' ? json.model : null;
          accepted = typeof decision?.choice === 'string';
        }
        return response;
      },
    });
    vm.runInContext(source, context, { timeout: 1000 });
    for (let index = 0; index < item.turns.length; index++) {
      active = item.turns[index];
      activeRecorded = replay?.results.find(
        result =>
          result.id === `${item.id}${repeats > 1 ? `#${repeat + 1}` : ''}` &&
          result.turn === index + 1
      );
      if (
        replay &&
        (!activeRecorded ||
          activeRecorded.rawLevel === null ||
          !activeRecorded.probabilities)
      ) {
        throw new Error(
          `Missing complete recorded decision for ${item.id} turn ${index + 1}`
        );
      }
      request = null;
      decision = undefined;
      accepted = false;
      responseModel = null;
      logs.length = 0;
      context.__tweakccRouterSyncSelection();
      const state = context.__tweakccRouterState();
      if (active.summary !== undefined) state.summary = active.summary;
      state.contextOmitted = !!active.omitted;
      const start = performance.now();
      await context.__tweakccRouterClassify(
        active.message,
        'prompt',
        values.model
      );
      const latencyMs = Math.round(performance.now() - start);
      const final = context.__tweakccRouterState();
      const level = Number.isInteger(final.level) ? final.level : null;
      const raw = decision as Decision | undefined;
      results.push({
        id: `${item.id}${repeats > 1 ? `#${repeat + 1}` : ''}`,
        domain: item.domain,
        turn: index + 1,
        allowed: active.allowed,
        rawLevel: raw?.choice !== undefined ? Number(raw.choice) : null,
        effort: final.effort || null,
        level,
        verdict:
          level === null
            ? 'missing'
            : level < active.allowed[0]
              ? 'under'
              : level > active.allowed[1]
                ? 'over'
                : 'within',
        latencyMs,
        fallback: final.decision
          ? final.decision.source === 'fallback'
          : !accepted || logs.some(log => log.includes('decision=fallback')),
        decision: final.decision || null,
        probabilities: raw?.probabilities || null,
        responseModel,
        confidence: raw?.confidence ?? null,
        requestBytes: request ? Buffer.byteLength(JSON.stringify(request)) : 0,
        request,
      });
      for (let flush = 0; flush < 12; flush++) await Promise.resolve();
    }
  }
}
const latencies = results.map(item => item.latencyMs).sort((a, b) => a - b);
const count = (verdict: string) =>
  results.filter(item => item.verdict === verdict).length;
const report = {
  mode: values.replay
    ? 'recorded-decisions-policy-replay'
    : values.live
      ? 'live-classifier-and-policy'
      : 'offline-policy-fixtures',
  replaySource: values.replay || null,
  requestMismatches,
  limitation:
    'Acceptable ranges are subjective calibration labels, not measured task quality. Haiku is mocked. Offline mode tests policy only, not prompt quality. No Claude task is executed.',
  model: values.model,
  runtime: values['runtime-file'] || 'current-source',
  counts: {
    turns: results.length,
    within: count('within'),
    over: count('over'),
    under: count('under'),
    missing: count('missing'),
    fallback: results.filter(item => item.fallback).length,
    noRequest: results.filter(item => item.requestBytes === 0).length,
    noDecision: results.filter(item => item.rawLevel === null).length,
  },
  rates: {
    over: count('over') / results.length,
    under: count('under') / results.length,
    fallback: results.filter(item => item.fallback).length / results.length,
  },
  latencyMs: {
    median: latencies[Math.floor(latencies.length / 2)],
    p95: latencies[
      Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)
    ],
  },
  rawToApplied: Object.fromEntries(
    [0, 1, 2, 3].map(raw => [
      String(raw),
      Object.fromEntries(
        [0, 1, 2, 3].map(applied => [
          String(applied),
          results.filter(
            item => item.rawLevel === raw && item.level === applied
          ).length,
        ])
      ),
    ])
  ),
  distribution: Object.fromEntries(
    ['low', 'medium', 'high', 'max'].map((effort, index) => [
      effort,
      results.filter(item => item.level === index).length,
    ])
  ),
  results,
};
if (values.out)
  await fs.writeFile(values.out, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
console.log(
  JSON.stringify(
    {
      ...report,
      results: results.map(result => ({ ...result, request: undefined })),
    },
    null,
    2
  )
);
