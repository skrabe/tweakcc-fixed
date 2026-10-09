import { describe, it, expect, vi } from 'vitest';
import { writeProposeGoal } from './proposeGoal';

// Verbatim from the CC 2.1.295 bundle.
const FIXTURE =
  'function N_n(){return k("tengu_propose_goal",!1)}' +
  'var K={isEnabled(){if(ve()||jn())return!1;if(Lt())return!1;if(!N_n())return!1;return!0}};';

describe('writeProposeGoal', () => {
  it('forces the tengu_propose_goal flag on', () => {
    expect(writeProposeGoal(FIXTURE)).toContain(
      'function N_n(){return !0;return k("tengu_propose_goal",!1)}'
    );
  });

  it('leaves the rest of isEnabled alone', () => {
    expect(writeProposeGoal(FIXTURE)).toContain(
      'isEnabled(){if(ve()||jn())return!1;if(Lt())return!1;if(!N_n())return!1;'
    );
  });

  it('is a no-op on its own output', () => {
    const once = writeProposeGoal(FIXTURE)!;
    expect(writeProposeGoal(once)).toBe(once);
  });

  it('fails when the flag is gone', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeProposeGoal('function a(){return 1}')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      'patch: proposeGoal: failed to find the tengu_propose_goal gate'
    );
    errorSpy.mockRestore();
  });
});
