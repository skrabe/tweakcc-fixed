import { afterEach, describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildHybridRuntime } from './complexityRouterHybrid';
import { ComplexityRouterConfig } from '../types';

const config: ComplexityRouterConfig = {
  enabled: true,
  provider: 'jev',
  pinPerTask: false,
  messageCap: 100000,
  assistantCap: 100000,
  timeoutMs: 1000,
  systemPrompt: 'Use {LEVELS}. Maximum index {MAX}.',
  levels: ['low', 'medium', 'high', 'max'].map((effort, index) => ({
    id: String(index),
    label: effort,
    help: effort,
    effort: effort as 'low' | 'medium' | 'high' | 'max',
  })),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => (resolve = done));
  return { promise, resolve };
}

function answer(level: number, confidence = 0.95) {
  return {
    answers: {
      effort: {
        type: 'choice',
        choice: String(level),
        confidence,
        probabilities: Object.fromEntries(
          config.levels.map((_, i) => [String(i), i === level ? 0.97 : 0.01])
        ),
      },
    },
  };
}

function harness(
  overrides: Partial<ComplexityRouterConfig> = {},
  directory?: string,
  sidFn: string | null = null
) {
  const summary = vi
    .fn()
    .mockResolvedValue({ summary: 'A concise active task' });
  const fetch = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify(answer(3))));
  const context = vm.createContext({
    __tweakccRouterSelectedModel: () => 'claude-opus-5-5',
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    process: {
      env: { TYPESAFE_API_KEY: 'test-secret' },
      stderr: { write: vi.fn() },
    },
    require: (id: string) =>
      id === 'fs' && !directory
        ? {}
        : id === 'os' && directory
          ? { homedir: () => directory }
          : createRequire(import.meta.url)(id),
    summary,
    agentContext: () => ({}),
    fetch,
  });
  vm.runInContext(
    buildHybridRuntime(
      { ...config, ...overrides },
      { gB: 'summary', km: 'agentContext' },
      sidFn,
      'require'
    ),
    context
  );
  return {
    context,
    fetch,
    summary,
    route: (text: string, messages?: unknown[], sid?: string) =>
      context.__tweakccRouterClassify(
        text,
        'prompt',
        'opus',
        messages,
        sid
      ) as Promise<void>,
    state: () => context.__tweakccRouterState(),
    observe: (messages: unknown[]) => context.__tweakccRouterObserve(messages),
  };
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe('Jev router generated runtime', () => {
  it('does no routing or summary work for normal model selections', async () => {
    const h = harness();
    h.context.__tweakccRouterSelectedModel = () => null;
    await h.route('Normal conversation');
    h.observe([
      { uuid: 'normal', type: 'assistant', message: { content: 'Reply' } },
    ]);
    h.context.__tweakccRouterCapture('Another reply');
    await flush();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.summary).not.toHaveBeenCalled();
    expect(h.state().effort).toBeUndefined();
  });

  it('switching away aborts pending work and restores native effort immediately', async () => {
    const h = harness();
    const route = deferred<Response>();
    const summary = deferred<unknown>();
    h.fetch.mockReturnValue(route.promise);
    h.summary.mockReturnValue(summary.promise);
    const pending = h.route('Pending task');
    await flush();
    h.state().effort = 'max';
    h.state().baseline = 'high';
    const routeSignal = h.fetch.mock.calls[0][1].signal;
    const summarySignal = h.summary.mock.calls[0][0].signal;
    h.context.__tweakccRouterSelectedModel = () => null;
    expect(h.context.__tweakccRouterSyncSelection()).toBeNull();
    expect(routeSignal.aborted).toBe(true);
    expect(summarySignal.aborted).toBe(true);
    expect(h.state().effort).toBeUndefined();
    expect(h.state().baseline).toBeUndefined();
    await pending;
    route.resolve(new Response(JSON.stringify(answer(3))));
    summary.resolve({ summary: 'Stale completion' });
    await flush();
    expect(h.state().effort).toBeUndefined();
    expect(h.state().summary).toBe('');
  });

  it('rejects a response when selection changes without an explicit sync call', async () => {
    const h = harness();
    const pending = deferred<Response>();
    h.fetch.mockReturnValue(pending.promise);
    const run = h.route('Old model');
    await flush();
    h.context.__tweakccRouterSelectedModel = () => 'claude-fable-5-1';
    pending.resolve(new Response(JSON.stringify(answer(3))));
    await run;
    expect(h.state().selectedModel).toBe('claude-fable-5-1');
    expect(h.state().effort).toBeUndefined();
  });

  it('retains context and ingests intervening conversation when reenabled', async () => {
    const h = harness();
    await h.route('Start task');
    await flush();
    const previous = h.state().summary;
    h.context.__tweakccRouterSelectedModel = () => null;
    h.context.__tweakccRouterSyncSelection();
    const intervening = [
      {
        uuid: 'intervening',
        type: 'assistant',
        message: { content: 'Found the root cause while routing was off' },
      },
    ];
    h.observe(intervening);
    h.context.__tweakccRouterSelectedModel = () => 'claude-opus-5-5';
    await h.route('Continue', intervening);
    const body = JSON.parse(h.fetch.mock.calls.at(-1)?.[1].body);
    expect(body.state.summary).toBe(previous);
    expect(body.state).not.toHaveProperty('previousEffort');
    expect(body.state.recentEvents).toContainEqual({
      role: 'assistant',
      text: 'Found the root cause while routing was off',
    });
  });

  it('an old summary cannot overwrite a new selection summary', async () => {
    const h = harness();
    const old = deferred<unknown>();
    h.summary
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ summary: 'New model summary' });
    await h.route('Old model task');
    h.context.__tweakccRouterSelectedModel = () => 'claude-fable-5-1';
    await h.route('New model task');
    await flush();
    old.resolve({ summary: 'Old stale summary' });
    await flush();
    expect(h.state().summary).toBe('New model summary');
  });

  it('routes without waiting for Haiku and sends summary plus fresh conversation', async () => {
    const h = harness();
    const pending = deferred<unknown>();
    h.summary.mockReturnValue(pending.promise);
    h.state().summary = 'Refactor parser across four packages';
    await h.route('Continue', [
      {
        uuid: 'a',
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Found ambiguous grammar' }],
        },
      },
    ]);
    expect(h.state().effort).toBe('max');
    const request = JSON.parse(h.fetch.mock.calls[0][1].body);
    expect(request.state.currentMessage).toBe('Continue');
    expect(request.state.summary).toContain('four packages');
    expect(request.state.recentEvents[0].text).toContain('ambiguous grammar');
    expect(h.summary.mock.calls[0][0].outputFormat.schema.properties).toEqual({
      summary: { type: 'string' },
    });
    pending.resolve({
      summary: 'Parser refactor; grammar ambiguity unresolved',
    });
    await flush();
    expect(h.state().summary).toContain('ambiguity');
  });

  it('captures pure-text completion asynchronously without routing again', async () => {
    const h = harness();
    await h.route('Explain the parser');
    await flush();
    h.observe([
      {
        uuid: 'reply',
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'The parser is recursive descent' }],
        },
      },
    ]);
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.summary.mock.calls.at(-1)?.[0].userPrompt).toContain(
      'recursive descent'
    );
  });

  it('rejects stale summaries after clear', async () => {
    const h = harness();
    const pending = deferred<unknown>();
    h.summary.mockReturnValue(pending.promise);
    await h.route('Old task');
    await h.route('/clear');
    pending.resolve({ summary: 'Old task stale result' });
    await flush();
    expect(h.state().summary).toBe('');
    expect(h.state().effort).toBeUndefined();
  });

  it('retains events arriving while a summary runs', async () => {
    const h = harness();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    h.summary
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await h.route('Implement parser');
    h.observe([
      {
        uuid: 'later',
        type: 'assistant',
        message: { content: 'Found failing tests' },
      },
    ]);
    first.resolve({ summary: 'Implement parser' });
    await flush();
    expect(
      h
        .state()
        .events.some((event: { text: string }) =>
          event.text.includes('failing tests')
        )
    ).toBe(true);
    expect(h.summary).toHaveBeenCalledTimes(2);
    second.resolve({ summary: 'Parser implementation has failing tests' });
    await flush();
  });

  it('lowers effort on the first confident smaller follow-up', async () => {
    const h = harness();
    await h.route('Hard task');
    h.fetch.mockImplementation(
      async () => new Response(JSON.stringify(answer(0)))
    );
    await h.route('Done, format a label');
    expect(h.state().effort).toBe('low');
    expect(h.state().decision).toMatchObject({
      source: 'jev',
      requestedEffort: 'low',
    });
    await h.route('Another label');
    expect(h.state().effort).toBe('low');
  });

  it('accepts moderate confidence without turning tier ambiguity into higher effort', async () => {
    const h = harness();
    h.fetch.mockImplementation(
      async () => new Response(JSON.stringify(answer(2, 0.47)))
    );
    await h.route('Investigate an interacting correctness failure');
    expect(h.state().effort).toBe('high');
    h.fetch.mockImplementation(
      async () => new Response(JSON.stringify(answer(0, 0.43)))
    );
    await h.route('Apply this exact formatting correction');
    expect(h.state().effort).toBe('low');
    expect(h.state().decision.source).toBe('jev');
  });

  it.each([0, 0.01, 0.27, 0.99])(
    'uses every valid Jev choice at confidence %s despite legacy pin settings',
    async confidence => {
      const h = harness({ pinPerTask: true });
      await h.route('Earlier task');
      h.fetch.mockImplementation(
        async () => new Response(JSON.stringify(answer(0, confidence)))
      );
      await h.route('Follow-up');
      expect(h.state().effort).toBe('low');
      expect(h.state().decision).toMatchObject({
        source: 'jev',
        requestedEffort: 'low',
        confidence,
      });
    }
  );

  it('bounds UTF8 input and exposes omissions without overriding Jev', async () => {
    const h = harness({ contextBudgetBytes: 4000 });
    h.fetch.mockImplementation(
      async () => new Response(JSON.stringify(answer(0)))
    );
    await h.route('漢字😺'.repeat(50000));
    await h.route('漢字😺'.repeat(50000));
    for (const call of h.fetch.mock.calls) {
      expect(Buffer.byteLength(call[1].body, 'utf8')).toBeLessThanOrEqual(4000);
      expect(JSON.parse(call[1].body).state.contextOmitted).toBe(true);
    }
    expect(h.state().effort).toBe('low');
  });

  it('does not retain historical difficulty solely because older context was omitted', async () => {
    const h = harness();
    await h.route('Hard task');
    h.state().contextOmitted = true;
    h.fetch.mockImplementation(
      async () => new Response(JSON.stringify(answer(0)))
    );
    await h.route('Format these three provided values as a list');
    expect(h.state().effort).toBe('low');
    expect(h.state().decision.source).toBe('jev');
  });

  it('does not retain high when Jev chooses medium with low confidence', async () => {
    const h = harness();
    h.fetch.mockImplementationOnce(
      async () => new Response(JSON.stringify(answer(2)))
    );
    await h.route('Earlier task');
    expect(h.state().effort).toBe('high');
    h.fetch.mockImplementation(
      async () => new Response(JSON.stringify(answer(1, 0.27)))
    );
    await h.route('A follow-up');
    expect(h.state().effort).toBe('medium');
    expect(h.state().decision).toMatchObject({
      source: 'jev',
      reason: 'classified',
      requestedEffort: 'medium',
      confidence: 0.27,
    });
  });

  it('leaves incomplete-context judgments to Jev even at low confidence', async () => {
    const h = harness({ contextBudgetBytes: 4000 });
    await h.route('Earlier task');
    h.fetch.mockImplementation(
      async () => new Response(JSON.stringify(answer(1, 0.27)))
    );
    await h.route('x'.repeat(10000));
    expect(h.state().effort).toBe('medium');
    expect(h.state().decision.source).toBe('jev');
  });

  it('reports fallback reason and returns to medium on a failed decision', async () => {
    const h = harness();
    await h.route('Hard task');
    h.fetch.mockImplementation(async () => new Response('{}', { status: 503 }));
    await h.route('Continue');
    expect(h.state().effort).toBe('medium');
    expect(h.state().decision).toMatchObject({
      source: 'fallback',
      reason: 'http-503',
    });
  });

  it('enforces deadline even when the transport ignores abort', async () => {
    vi.useFakeTimers();
    const h = harness({ jevTimeoutMs: 20 });
    h.fetch.mockReturnValue(new Promise(() => {}));
    const run = h.route('Investigate');
    await vi.advanceTimersByTimeAsync(30);
    await run;
    expect(h.state().effort).toBe('medium');
  });

  it('cannot apply an older overlapping route after a newer turn', async () => {
    const h = harness();
    const first = deferred<Response>();
    h.fetch.mockReturnValueOnce(first.promise);
    const older = h.route('Older turn');
    await flush();
    await h.route('New turn');
    first.resolve(new Response(JSON.stringify(answer(0))));
    await older;
    expect(h.state().effort).toBe('max');
  });

  it('uses confident low effort immediately on a fully observed first turn', async () => {
    const h = harness();
    h.fetch.mockImplementation(
      async () => new Response(JSON.stringify(answer(0)))
    );
    await h.route('Rename this variable');
    expect(h.state().effort).toBe('low');
  });

  it('preserves omissions introduced while an older summary was running', async () => {
    const h = harness();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    h.summary
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await h.route('Initial request');
    h.observe([
      {
        uuid: 'big',
        type: 'assistant',
        message: { content: 'a'.repeat(12000) },
      },
    ]);
    first.resolve({ summary: 'Initial request' });
    await flush();
    expect(h.state().contextOmitted).toBe(true);
    await h.route('Continue');
    const body = JSON.parse(h.fetch.mock.calls.at(-1)?.[1].body);
    expect(body.state.contextOmitted).toBe(true);
    second.resolve({ summary: 'Large response was truncated' });
    await flush();
  });

  it('invalidates in-flight summaries when switching sessions', async () => {
    const h = harness();
    const old = deferred<unknown>();
    h.summary.mockReturnValueOnce(old.promise);
    await h.route('Old session', [], 'old');
    await h.route('New session', [], 'new');
    old.resolve({ summary: 'Stale old session' });
    await flush();
    expect(h.state().sid).toBe('new');
    expect(h.state().summary).not.toContain('Stale');
  });

  it('persists atomically with private permissions and restores session context', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tweakcc-router-test-')
    );
    try {
      const first = harness({}, directory);
      await first.route('Refactor four modules', [], 'session');
      await flush();
      await Promise.all(first.context.__tweakccRouterWrites.values());
      const file = path.join(directory, '.tweakcc/router-state/session.json');
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect(
        (await fs.readdir(path.dirname(file))).filter(name =>
          name.endsWith('.tmp')
        )
      ).toEqual([]);
      const next = harness({}, directory);
      await next.route('Continue', [], 'session');
      const body = JSON.parse(next.fetch.mock.calls[0][1].body);
      expect(body.state.summary).toBe('A concise active task');
      expect(body.state).not.toHaveProperty('previousEffort');
      expect(next.state().effort).toBe('max');
      await flush();
      await Promise.all(next.context.__tweakccRouterWrites.values());
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects completion from a prior session, turn or lifecycle generation', async () => {
    const h = harness();
    const stamp = await h.context.__tweakccRouterClassify(
      'Initial',
      'prompt',
      'opus',
      [],
      'active'
    );
    const message = [
      {
        uuid: 'stale',
        type: 'assistant',
        message: { content: 'Stale completion' },
      },
    ];
    await flush();
    const before = h.summary.mock.calls.length;
    h.context.__tweakccRouterObserve(message, 'other', stamp);
    h.context.__tweakccRouterObserve(message, 'active', {
      ...stamp,
      turn: stamp.turn - 1,
    });
    h.context.__tweakccRouterObserve(message, 'active', {
      ...stamp,
      generation: stamp.generation - 1,
    });
    await flush();
    expect(h.summary).toHaveBeenCalledTimes(before);
    expect(h.state().events).toEqual([]);
    h.context.__tweakccRouterObserve(message, 'active', stamp);
    await flush();
    expect(h.summary).toHaveBeenCalledTimes(before + 1);
  });

  it('reseeds only from committed compaction and ignores stale summaries', async () => {
    const h = harness();
    const old = deferred<unknown>();
    h.summary
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ summary: 'Updated compacted task' });
    await h.route('Old history');
    const transcript = [
      {
        uuid: 'old-message',
        type: 'assistant',
        message: { content: 'Discarded old detail' },
      },
      { uuid: 'boundary', type: 'system', subtype: 'compact_boundary' },
      {
        uuid: 'compact',
        type: 'user',
        isCompactSummary: true,
        message: { content: 'Committed summary: parser migration' },
      },
      {
        uuid: 'preserved',
        type: 'assistant',
        message: { content: 'Preserved result' },
      },
    ];
    await h.route('Continue migration', transcript);
    const body = JSON.parse(h.fetch.mock.calls.at(-1)?.[1].body);
    expect(body.state.summary).toBe('');
    expect(body.state.contextOmitted).toBe(true);
    expect(h.summary.mock.calls[1][0].userPrompt).toContain(
      'Committed summary: parser migration'
    );
    expect(JSON.stringify(body.state.recentEvents)).toContain(
      'Preserved result'
    );
    expect(JSON.stringify(body.state.recentEvents)).not.toContain(
      'Discarded old detail'
    );
    old.resolve({ summary: 'Stale precompaction summary' });
    await flush();
    const generation = h.state().generation;
    await h.route('Check results', transcript);
    expect(h.state().generation).toBe(generation);
    expect(JSON.parse(h.fetch.mock.calls.at(-1)?.[1].body).state.summary).toBe(
      'Updated compacted task'
    );
  });

  it('sends every native compaction character to Haiku before accepting a bounded digest', async () => {
    const h = harness();
    const complete = deferred<unknown>();
    const source =
      'START ' +
      'a'.repeat(14000) +
      'CRITICAL MIDDLE FACT' +
      'b'.repeat(14000) +
      ' END';
    h.state().summary = 'Previously completed router summary';
    const pieces: string[] = [];
    h.summary.mockImplementation(async (args: { userPrompt: string }) => {
      const input = JSON.parse(args.userPrompt);
      if (input.compactionDocument !== undefined) {
        pieces.push(input.compactionDocument);
        if (input.compactionPart.end === input.compactionPart.total)
          return complete.promise;
        return { summary: 'Partial semantic digest' };
      }
      return { summary: 'Final digest with current turn' };
    });
    await h.route('Continue', [
      {
        uuid: 'native-large',
        type: 'user',
        isCompactSummary: true,
        message: { content: source },
      },
    ]);
    await flush();
    expect(pieces.join('')).toBe(source);
    expect(pieces.some(piece => piece.includes('CRITICAL MIDDLE FACT'))).toBe(
      true
    );
    expect(h.state().summary).toBe('Previously completed router summary');
    const body = JSON.parse(h.fetch.mock.calls[0][1].body);
    expect(body.state.summary).toBe('Previously completed router summary');
    expect(body.state.contextOmitted).toBe(true);
    expect(JSON.stringify(body)).not.toContain('CRITICAL MIDDLE FACT');
    complete.resolve({
      summary: 'Complete semantic digest retaining CRITICAL MIDDLE FACT',
    });
    await flush();
    expect(h.state().compactionSource).toBeUndefined();
    expect(h.state().summary).toBe('Final digest with current turn');
  });

  it('retries invalid compaction digests without advancing or trimming their source', async () => {
    const h = harness({ summaryMaxChars: 500 });
    const source = 'header ' + 'm'.repeat(9000) + ' middle ' + 't'.repeat(9000);
    h.state().pendingCompaction = source;
    h.summary.mockResolvedValue({ summary: 'x'.repeat(501) });
    await h.route('Continue');
    await flush();
    expect(h.state().compactionSource.text).toBe(source);
    expect(h.state().compactionSource.offset).toBe(0);
    expect(h.summary).toHaveBeenCalledTimes(1);
    h.summary.mockRejectedValueOnce(new Error('temporary failure'));
    await h.route('Continue again');
    await flush();
    expect(h.state().compactionSource.offset).toBe(0);
    h.summary.mockResolvedValue({ summary: 'Complete bounded digest' });
    await h.route('Retry');
    await flush();
    expect(h.state().compactionSource).toBeUndefined();
    expect(h.state().summary).toBe('Complete bounded digest');
  });

  it('aborts a pending compaction digest on clear and ignores its late result', async () => {
    const h = harness();
    const pending = deferred<unknown>();
    h.summary.mockReturnValue(pending.promise);
    h.state().pendingCompaction = 'Full native document';
    await h.route('Continue');
    const signal = h.summary.mock.calls[0][0].signal;
    await h.route('/clear');
    pending.resolve({ summary: 'Stale native digest' });
    await flush();
    expect(signal.aborted).toBe(true);
    expect(h.state().summary).toBe('');
    expect(h.state().compactionSource).toBeUndefined();
  });

  it('keeps omissions in unsummarized events when the native digest completes', async () => {
    const h = harness();
    const digest = deferred<unknown>();
    const events = deferred<unknown>();
    h.summary
      .mockReturnValueOnce(digest.promise)
      .mockReturnValue(events.promise);
    await h.route('Continue', [
      {
        uuid: 'compact-event',
        type: 'user',
        isCompactSummary: true,
        message: { content: 'Native compaction document' },
      },
    ]);
    h.observe([
      {
        uuid: 'large-event',
        type: 'assistant',
        message: { content: 'x'.repeat(20000) },
      },
    ]);
    digest.resolve({ summary: 'Complete native digest' });
    await flush();
    expect(h.state().compactionSource).toBeUndefined();
    expect(h.state().contextOmitted).toBe(true);
    const input = JSON.parse(h.summary.mock.calls[1][0].userPrompt);
    expect(input.contextOmitted).toBe(true);
    expect(input.events[1].text).toContain('[content omitted]');
    events.resolve({ summary: 'Digest with event omission accounted for' });
    await flush();
  });

  it('persists full pending compaction input and resumes at the accepted chunk boundary', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tweakcc-router-test-')
    );
    try {
      const source =
        'a'.repeat(12000) + 'UNPROCESSED MIDDLE ' + 'b'.repeat(9000);
      const transcript = [
        {
          uuid: 'compact-full',
          type: 'user',
          isCompactSummary: true,
          message: { content: source },
        },
      ];
      const first = harness({}, directory);
      first.summary
        .mockResolvedValueOnce({ summary: 'Accepted first chunk digest' })
        .mockReturnValue(new Promise(() => {}));
      await first.route('Continue', transcript, 'session');
      await flush();
      await Promise.all(first.context.__tweakccRouterWrites.values());
      expect(first.state().compactionSource.offset).toBe(12000);
      const next = harness({}, directory);
      const pending = deferred<unknown>();
      next.summary.mockReturnValue(pending.promise);
      await next.route('Continue after restart', transcript, 'session');
      expect(next.state().compactionSource.text).toBe(source);
      const input = JSON.parse(next.summary.mock.calls[0][0].userPrompt);
      expect(input.previousSummary).toBe('Accepted first chunk digest');
      expect(input.compactionDocument).toBe(source.slice(12000));
      expect(input.compactionDocument).toContain('UNPROCESSED MIDDLE');
      first.context.__tweakccRouterSelectedModel = () => null;
      first.context.__tweakccRouterSyncSelection();
      pending.resolve({ summary: 'Resumed complete digest' });
      await flush();
      await Promise.all(next.context.__tweakccRouterWrites.values());
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('persists the committed compaction marker across resume', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tweakcc-router-test-')
    );
    try {
      const transcript = [
        { uuid: 'boundary', type: 'system', subtype: 'compact_boundary' },
        {
          uuid: 'compact',
          type: 'user',
          isCompactSummary: true,
          message: { content: 'Original compact summary' },
        },
      ];
      const first = harness({}, directory);
      await first.route('Continue', transcript, 'session');
      await flush();
      await Promise.all(first.context.__tweakccRouterWrites.values());
      const next = harness({}, directory);
      await next.route('Continue later', transcript, 'session');
      expect(next.state().generation).toBe(0);
      expect(JSON.parse(next.fetch.mock.calls[0][1].body).state.summary).toBe(
        'A concise active task'
      );
      await flush();
      await Promise.all(next.context.__tweakccRouterWrites.values());
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('prefers an explicit session hint over an unavailable cross-module accessor', async () => {
    const h = harness({}, undefined, 'missingSidAccessor');
    await h.route('Route this session', [], 'explicit-session');
    await flush();
    expect(h.state().sid).toBe('explicit-session');
    const before = h.summary.mock.calls.length;
    h.context.__tweakccRouterObserve(
      [
        {
          uuid: 'completion',
          type: 'assistant',
          message: { content: 'Completed correctly' },
        },
      ],
      'explicit-session'
    );
    await flush();
    expect(h.summary).toHaveBeenCalledTimes(before + 1);
  });

  it('excludes nested binary payloads while retaining tool-result text', async () => {
    const h = harness();
    await h.route('Inspect the result', [
      {
        uuid: 'tools',
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: [
                { type: 'text', text: 'Image export succeeded' },
                {
                  type: 'image',
                  source: { type: 'base64', data: 'SENSITIVE_BINARY_PAYLOAD' },
                },
                {
                  type: 'document',
                  source: { data: 'DOCUMENT_BINARY_PAYLOAD' },
                },
              ],
            },
          ],
        },
      },
    ]);
    const request = h.fetch.mock.calls[0][1].body;
    expect(request).toContain('Image export succeeded');
    expect(request).toContain('non-text content unavailable');
    expect(request).not.toContain('SENSITIVE_BINARY_PAYLOAD');
    expect(request).not.toContain('DOCUMENT_BINARY_PAYLOAD');
    expect(JSON.parse(request).state.contextOmitted).toBe(true);
    expect(h.summary.mock.calls[0][0].userPrompt).not.toContain(
      'BINARY_PAYLOAD'
    );
  });

  it('uses a single configured effort without sending an invalid Choice request', async () => {
    const h = harness({ levels: [config.levels[0]] });
    await h.route('One fixed tier');
    expect(h.state().effort).toBe('low');
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.summary).toHaveBeenCalledTimes(1);
  });

  it('falls back conservatively when more than 255 tiers are configured', async () => {
    const h = harness({
      levels: Array.from({ length: 256 }, (_, index) => ({
        ...config.levels[2],
        id: String(index),
      })),
    });
    await h.route('Unsupported tier count');
    expect(h.state().effort).toBe('high');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rejects noncanonical choices, malformed distributions and unbounded confidence', () => {
    const h = harness();
    for (const value of [
      {
        ...answer(0),
        answers: { effort: { ...answer(0).answers.effort, choice: '00' } },
      },
      {
        ...answer(0),
        answers: {
          effort: { ...answer(0).answers.effort, probabilities: { '0': 1 } },
        },
      },
      answer(0, 2),
    ])
      expect(h.context.__tweakccRouterDecision(value)).toBeNull();
  });
});
