import { describe, it, expect, vi } from 'vitest';
import { writeHideStartupClawd } from './hideStartupClawd';

// hide-startup-clawd nulls out the Clawd splash component so the binary boots
// without the ASCII-art mascot. The patch:
//   1. locates the '▛███▜' Clawd art literal,
//   2. walks back <=2000 chars to the LAST `function NAME(...){` (the INNER
//      component, e.g. MKz),
//   3. scans ALL functions for the WRAPPER whose body createElement's that
//      inner name (e.g. cE6 -> createElement(MKz,...)),
//   4. splices `return null;` at the wrapper's body start.
// Fixture mirrors that two-layer minified shape (inner MKz before the art,
// wrapper cE6 createElement'ing MKz).
const FIXTURE =
  'q$1=2;' +
  'function cE6(A){return A.isApple?Z.createElement(MKz,{logo:A.logo}):Z.createElement("pre",null,"ascii")}' +
  'function MKz(A){return Z.createElement("pre",null,"▛███▜▙▟")}' +
  ';tail=3;';

describe('writeHideStartupClawd', () => {
  it('splices `return null;` at the WRAPPER component body start', () => {
    const out = writeHideStartupClawd(FIXTURE);
    expect(out).not.toBeNull();
    // The wrapper cE6's body must now begin with the early return.
    expect(out).toContain('function cE6(A){return null;return A.isApple?');
    // Inner MKz is left intact (we target the wrapper, not the inner).
    expect(out).toContain('function MKz(A){return Z.createElement("pre"');
    // Exactly one insertion.
    expect(out!.match(/return null;/g)!.length).toBe(1);
  });

  it('matches the unicode-escaped Clawd art form (\\u259B…\\u259C)', () => {
    // Some builds emit the art as escaped unicode in a string literal.
    const escaped =
      'function wrap1(A){return A.t?Z.createElement(inner1,A):null}' +
      'function inner1(A){return"\\u259B\\u2588\\u2588\\u2588\\u259C"}' +
      ';end';
    const out = writeHideStartupClawd(escaped);
    expect(out).not.toBeNull();
    expect(out).toContain('function wrap1(A){return null;return A.t?');
  });

  it('falls back to the INNER function when no wrapper createElements it', () => {
    // No function createElement's MKz, so the wrapper search fails and the
    // patch nulls the inner function directly.
    const noWrapper =
      'function MKz(A){return Z.createElement("pre",null,"▛███▜")}' +
      ';rest=1;';
    const out = writeHideStartupClawd(noWrapper);
    expect(out).not.toBeNull();
    expect(out).toContain('function MKz(A){return null;return Z.createElement');
    expect(out!.match(/return null;/g)!.length).toBe(1);
  });

  it('returns null (logging) when no Clawd art is present', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeHideStartupClawd('function unrelated(A){return A+1}')
    ).toBeNull();
    errSpy.mockRestore();
  });

  it('produces a parseable result (early return is syntactically valid)', () => {
    const out = writeHideStartupClawd(FIXTURE)!;
    expect(
      () => new Function(`var Z={createElement(){}};${out}`)
    ).not.toThrow();
  });
});
