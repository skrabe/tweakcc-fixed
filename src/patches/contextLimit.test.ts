import { describe, it, expect, vi } from 'vitest';
import { writeContextLimit } from './contextLimit';

const OVERRIDE = '(+process.env.CLAUDE_CODE_CONTEXT_LIMIT||200000)';

describe('writeContextLimit', () => {
  it('overrides BOTH 200000 constants in the CC >=2.1.18x two-constant shape', () => {
    // The window is min(o-from-fkt, KQ), so both must be overridden or the
    // override would be capped by the un-overridden one.
    const input =
      'q=1;var fkt=200000,KQ=200000,Akt=20000,MWu=32000,NWu=128000;z=2;';
    const out = writeContextLimit(input);
    expect(out).toBe(
      `q=1;var fkt=${OVERRIDE},KQ=${OVERRIDE},Akt=20000,MWu=32000,NWu=128000;z=2;`
    );
  });

  it('accepts the 64000 fourth-constant variant', () => {
    const input = 'var a=200000,b=200000,c=20000,d=32000,e=64000;';
    const out = writeContextLimit(input);
    expect(out).toContain(
      `var a=${OVERRIDE},b=${OVERRIDE},c=20000,d=32000,e=64000;`
    );
  });

  it('falls back to the older single-200000 shape', () => {
    const input = 'var aa=200000,bb=20000,cc=32000,dd=128000;';
    const out = writeContextLimit(input);
    expect(out).toBe(`var aa=${OVERRIDE},bb=20000,cc=32000,dd=128000;`);
  });

  it('returns null (logging) when neither shape is present', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeContextLimit('function unrelated(){return 1}')).toBeNull();
    errSpy.mockRestore();
  });

  it('produces a valid JS declaration', () => {
    const out = writeContextLimit(
      'var fkt=200000,KQ=200000,Akt=20000,MWu=32000,NWu=128000;'
    )!;
    expect(() => new Function(out + 'return 1;')).not.toThrow();
  });
});
