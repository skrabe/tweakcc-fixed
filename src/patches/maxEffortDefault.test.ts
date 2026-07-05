import { describe, expect, it, vi } from 'vitest';

import { writeMaxEffortDefault } from './maxEffortDefault';

// The launch-effort gate must survive untouched — that's what lets `/effort`
// override the max default within a session. A previous revision forced this
// gate permanently open, which made effort snap back to "max" on every
// recompute; this constant guards against re-introducing that.
const GATE =
  'function TVH(H){let _=A7(H);if(_.includes("opus-4-7"))return!I_().unpinOpus47LaunchEffort;if(_.includes("opus-4-8"))return!I_().unpinOpus48LaunchEffort;return!1}';

describe('maxEffortDefault', () => {
  it('rewrites the CC 2.1.156 per-model default (4.7 and 4.8) to "max"', () => {
    const file =
      'const x=1;' +
      'function YK6(H){if(A7(H)==="claude-opus-4-8")return"high";if(A7(H)==="claude-opus-4-7")return"xhigh";return"high"}' +
      GATE;

    const result = writeMaxEffortDefault(file);

    expect(result).not.toBeNull();
    expect(result).toContain(
      'function YK6(H){if(A7(H)==="claude-opus-4-8")return"max";if(A7(H)==="claude-opus-4-7")return"max";return"high"}'
    );
    // The unpin gate is left exactly as-is, so /effort still overrides.
    expect(result).toContain(GATE);
  });

  it('rewrites the older single-model (4.7-only) default to "max"', () => {
    const file =
      'function hn_(H){if(JK(H)==="claude-opus-4-7")return"xhigh";return"high"}';

    const result = writeMaxEffortDefault(file);

    expect(result).toBe(
      'function hn_(H){if(JK(H)==="claude-opus-4-7")return"max";return"high"}'
    );
  });

  it('is a no-op when the default is already "max"', () => {
    const file =
      'function YK6(H){if(A7(H)==="claude-opus-4-8")return"max";if(A7(H)==="claude-opus-4-7")return"max";return"high"}' +
      GATE;

    expect(writeMaxEffortDefault(file)).toBe(file);
  });

  it('rewrites the CC 2.1.199+ data-driven catalog default_effort to "max"', () => {
    const file =
      'var a=1;' +
      '{id:"claude-sonnet-5",capabilities:["adaptive_thinking"],default_effort:"high",image_l:1},' +
      '{id:"claude-opus-4-7",capabilities:["fast_mode"],default_effort:"xhigh",image_l:1},' +
      '{id:"claude-opus-4-8",capabilities:["lean_prompt"],default_effort:"high",image_l:1},' +
      '{id:"claude-fable-5",capabilities:["fable_5_mitigations"],default_effort:"high",image_l:1}';

    const result = writeMaxEffortDefault(file);

    expect(result).not.toBeNull();
    // Both Opus defaults flip to "max" (non-greedy anchor hits each model's own
    // field, not a neighbor's).
    expect(result).toContain(
      'id:"claude-opus-4-8",capabilities:["lean_prompt"],default_effort:"max"'
    );
    expect(result).toContain(
      'id:"claude-opus-4-7",capabilities:["fast_mode"],default_effort:"max"'
    );
    // Sonnet and Fable are left exactly as-is.
    expect(result).toContain(
      'id:"claude-sonnet-5",capabilities:["adaptive_thinking"],default_effort:"high"'
    );
    expect(result).toContain(
      'id:"claude-fable-5",capabilities:["fable_5_mitigations"],default_effort:"high"'
    );
  });

  it('is a no-op when the catalog default_effort is already "max"', () => {
    const file =
      '{id:"claude-opus-4-8",capabilities:["lean_prompt"],default_effort:"max",image_l:1},' +
      '{id:"claude-opus-4-7",capabilities:["fast_mode"],default_effort:"max",image_l:1}';

    expect(writeMaxEffortDefault(file)).toBe(file);
  });

  it('returns null when the per-model default is absent', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      expect(writeMaxEffortDefault('const x=1;')).toBeNull();
      expect(consoleError).toHaveBeenCalledWith(
        'patch: maxEffortDefault: failed to find Opus per-model effort default'
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
