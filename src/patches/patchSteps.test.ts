import { describe, expect, it } from 'vitest';

import { runPatchSteps } from './patchSteps';

describe('runPatchSteps', () => {
  it('threads each step the previous step output', () => {
    expect(runPatchSteps('a', [f => f + 'b', f => f + 'c'])).toBe('abc');
  });

  it('stops at the first step that fails', () => {
    const seen: string[] = [];
    const result = runPatchSteps('a', [
      f => {
        seen.push(f);
        return null;
      },
      f => {
        seen.push(f);
        return f;
      },
    ]);
    expect(result).toBeNull();
    expect(seen).toEqual(['a']);
  });

  it('returns the input when there are no steps', () => {
    expect(runPatchSteps('a', [])).toBe('a');
  });
});
