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

  it('flips the 2.1.267 tri-state capability shape', () => {
    const gate =
      'function nae(e,n){let o=pm(e,"fable_5_mitigations",n);if(o!==void 0)return o;if(e==="claude-mythos-5")return!0;return!1}';
    const src = `var A=1;${gate}var B=2;`;
    const out = writeAutonomousOperationAllModels(src);
    expect(out).toBe(
      `var A=1;${gate.replace(/return!1\}$/, 'return!0}')}var B=2;`
    );
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

  it('also turns on finishing_work_guidance for every model (2.1.322 shape)', () => {
    const resolver =
      'var ot=new Set(["silent_turn_reminder","finishing_work_guidance","memory_guidance"]),nt=64;' +
      'function vT(e,n,r,s){if(s!==void 0)return s;let d=vb(n,e,r);if(d!==void 0)return d;let h=ot.has(e)&&Z(n);return h}';
    const gate =
      'function nae(e,n){let o=pm(e,"fable_5_mitigations",n);if(o!==void 0)return o;if(e==="claude-mythos-5")return!0;return!1}';
    const out = writeAutonomousOperationAllModels(`${gate};${resolver}`)!;
    expect(out).toContain('if(e==="claude-mythos-5")return!0;return!0}');
    expect(out).toContain(
      'let d=vb(n,e,r);if(d!==void 0)return d;if(e=="finishing_work_guidance")return!0;let h=ot.has(e)'
    );
    expect(writeAutonomousOperationAllModels(out)).toBe(out);
  });
});
