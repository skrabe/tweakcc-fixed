import { describe, it, expect, vi } from 'vitest';
import { writeVerboseProperty } from './verboseProperty';

// Fixtures mirror the two real shapes writeVerboseProperty targets, distilled
// from the CC 2.1.183 cli.js so this catches a regex-anchor drift on a bump.
// verbose-property is an ALWAYS_APPLIED patch with no other safety net.

describe('writeVerboseProperty', () => {
  it('replaces verbose:X with verbose:true in the createElement object literal (older CC shape)', () => {
    const input =
      'q.createElement(z,{responseLengthRef:o,spinnerSuffix:d,thinkingStatus:t,isCompacting:l,verbose:x})';

    const out = writeVerboseProperty(input);

    expect(out).not.toBeNull();
    expect(out).toContain('verbose:true');
    // the original `verbose:x` value must be gone
    expect(out).not.toMatch(/verbose:x[,}]/);
  });

  it('forces the destructured verbose var true at the function body start (CC >= 2.1.113)', () => {
    // Real 2.1.183 shape: function ({...,overrideMessage:a,...,verbose:p,...}){...}
    const input =
      'function aS1({overrideColor:s,overrideMessage:a,spinnerSuffix:d,verbose:p,turnEffort:f}){return null}';

    const out = writeVerboseProperty(input);

    expect(out).not.toBeNull();
    // `p=!0;` is injected immediately after the `){` that opens the body,
    // not as a destructure-literal replacement (which would be a SyntaxError).
    expect(out).toContain('verbose:p,turnEffort:f}){p=!0;return null}');
  });

  it('returns null (without throwing) when neither shape is present', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeVerboseProperty('function unrelated(a,b){return a+b}')
    ).toBeNull();
    errSpy.mockRestore();
  });
});
