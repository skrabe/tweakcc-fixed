import { describe, expect, it, vi } from 'vitest';

import { writeAutonomousOperationAllModels } from './autonomousOperationAllModels';

// The model-family predicate: true only for fable-5/mythos-5. We flip the
// fallback so every model is treated as fable/mythos.
const GATE =
  'function zQ(e){if(e==="claude-fable-5"||e==="claude-mythos-5")return!0;return!1}';
const FLIPPED =
  'function zQ(e){if(e==="claude-fable-5"||e==="claude-mythos-5")return!0;return!0}';

describe('autonomousOperationAllModels (treat model as fable/mythos)', () => {
  it('flips the model-family gate fallback to true', () => {
    const result = writeAutonomousOperationAllModels(`const x=1;${GATE};`);
    expect(result).toBe(`const x=1;${FLIPPED};`);
  });

  it('tolerates minifier-renamed function/arg identifiers', () => {
    const file =
      'function $Q9(W){if(W==="claude-fable-5"||W==="claude-mythos-5")return!0;return!1}';
    expect(writeAutonomousOperationAllModels(file)).toBe(
      'function $Q9(W){if(W==="claude-fable-5"||W==="claude-mythos-5")return!0;return!0}'
    );
  });

  it('is a no-op when already flipped', () => {
    expect(writeAutonomousOperationAllModels(FLIPPED)).toBe(FLIPPED);
  });

  it('flips the 2.1.195 feature-gate fable arm shape', () => {
    const src =
      'var A=1;function Bte(e){if(tU(e,"fable_5_mitigations")||e==="claude-mythos-5")return!0;return!1}var B=2;';
    const out = writeAutonomousOperationAllModels(src);
    expect(out).toContain(
      'function Bte(e){if(tU(e,"fable_5_mitigations")||e==="claude-mythos-5")return!0;return!0}'
    );
    expect(out).toContain('var A=1;');
    expect(out).toContain('var B=2;');
    // idempotent
    expect(writeAutonomousOperationAllModels(out as string)).toBe(out);
  });

  it('errors when the model ids are present but the gate shape changed', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      const file = 'if(m==="claude-fable-5")doSomethingElse();';
      expect(writeAutonomousOperationAllModels(file)).toBeNull();
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('no-ops (does not error) when the model ids are absent entirely', () => {
    expect(writeAutonomousOperationAllModels('const x=1;')).toBe('const x=1;');
  });
});
