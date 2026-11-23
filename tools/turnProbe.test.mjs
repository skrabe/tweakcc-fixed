import { describe, it, expect, vi } from 'vitest';
import {
  classifyOutcome,
  parseUsageLimit,
  probeWithRetry,
  EXIT_USAGE_LIMIT,
} from './turnProbe.mjs';

const USAGE_LIMIT_PANE = `   > Reply with exactly the word PONG and nothing else.
  ⎿  You've hit your 5-hour limit · resets 1:20pm (Europe/Podgorica)
⏺ Usage limit reached · continuing automatically at 1:20pm · esc to cancel
❯
  ⚠ Usage limit reached · limit resets 1:20pm
    Continuing automatically at 1:20pm · Esc to cancel · /usage-credits to continue now
  Opus 5.5 medium │ ░░░░░░░░░░░░ 0% 1M │ 5h 100% ↻2h41m  7d 47% ↻17h21m
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

const PLAIN_429_PANE = `   > Reply with exactly the word PONG and nothing else.
  ⎿  API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}
❯
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

const CRASH_PANE = `Claude Code exited after an unrecoverable interface error (Text string " > Reply with exactly the word PONG and nothing else. " must be rendered inside <Text> component).
[EXIT=1]
`;

const req = (id, kind, status) => ({ id, kind, status });
const BLOCKED = [
  req('001', 'other', 200),
  req('002', 'side-call', 429),
  req('003', 'side-call', 429),
  req('004', 'main-loop', 429),
];

describe('parseUsageLimit', () => {
  it('reads the reset time with its timezone from the 5-hour banner', () => {
    expect(parseUsageLimit(USAGE_LIMIT_PANE)).toEqual({
      resets: '1:20pm (Europe/Podgorica)',
    });
  });

  it('reads the reset time from the footer banner alone', () => {
    expect(
      parseUsageLimit('  ⚠ Usage limit reached · limit resets 1:20pm\n')
    ).toEqual({ resets: '1:20pm' });
  });

  it('matches a banner without a reset time', () => {
    expect(parseUsageLimit('⏺ Usage limit reached\n')).toEqual({
      resets: null,
    });
  });

  it('ignores panes without the banner', () => {
    expect(parseUsageLimit(PLAIN_429_PANE)).toBeNull();
    expect(parseUsageLimit(CRASH_PANE)).toBeNull();
  });
});

describe('classifyOutcome', () => {
  it('reports a usage limit when a 429 comes with the banner', () => {
    expect(
      classifyOutcome({
        requests: BLOCKED,
        pane: USAGE_LIMIT_PANE,
        gotPong: false,
      })
    ).toEqual({ verdict: 'usage-limit', resets: '1:20pm (Europe/Podgorica)' });
  });

  it('reports a plain 429 on the main loop as rate-limited', () => {
    expect(
      classifyOutcome({
        requests: BLOCKED,
        pane: PLAIN_429_PANE,
        gotPong: false,
      })
    ).toEqual({ verdict: 'rate-limited' });
  });

  it('treats a real no-API failure as a failure', () => {
    expect(
      classifyOutcome({
        requests: [req('001', 'other', 200), req('002', 'side-call', 429)],
        pane: CRASH_PANE,
        gotPong: false,
      })
    ).toEqual({ verdict: 'fail' });
    expect(
      classifyOutcome({ requests: [], pane: CRASH_PANE, gotPong: false })
    ).toEqual({ verdict: 'fail' });
  });

  it('does not call a banner a usage limit when no request got a 429', () => {
    expect(
      classifyOutcome({
        requests: [req('001', 'main-loop', 200)],
        pane: USAGE_LIMIT_PANE,
        gotPong: false,
      })
    ).toEqual({ verdict: 'fail' });
  });

  it('passes a retried 429 followed by a 200 with a rendered reply', () => {
    expect(
      classifyOutcome({
        requests: [req('001', 'main-loop', 429), req('002', 'main-loop', 200)],
        pane: USAGE_LIMIT_PANE,
        gotPong: true,
      })
    ).toEqual({ verdict: 'ok' });
  });
});

describe('probeWithRetry', () => {
  it('uses a distinct exit code for the usage limit', () => {
    expect(EXIT_USAGE_LIMIT).not.toBe(0);
    expect(EXIT_USAGE_LIMIT).not.toBe(1);
  });

  it('retries a plain 429 once after the backoff', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 1, verdict: 'rate-limited' })
      .mockResolvedValueOnce({ code: 0, verdict: 'ok' });
    const wait = vi.fn().mockResolvedValue();
    const result = await probeWithRetry(run, { backoffMs: 1234, wait });
    expect(result).toEqual({ code: 0, verdict: 'ok' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1234);
  });

  it('retries only once when the 429 persists', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, verdict: 'rate-limited' });
    const result = await probeWithRetry(run, {
      backoffMs: 1,
      wait: async () => {},
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.code).toBe(1);
  });

  it.each([
    [{ code: EXIT_USAGE_LIMIT, verdict: 'usage-limit' }],
    [{ code: 1, verdict: 'fail' }],
    [{ code: 0, verdict: 'ok' }],
  ])('does not retry %o', async outcome => {
    const run = vi.fn().mockResolvedValue(outcome);
    const wait = vi.fn();
    expect(await probeWithRetry(run, { backoffMs: 1, wait })).toEqual(outcome);
    expect(run).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});
