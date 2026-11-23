import { describe, it, expect, vi } from 'vitest';
import { writeContextLimit } from './contextLimit';

const OVERRIDE = '(+process.env.CLAUDE_CODE_CONTEXT_LIMIT||200000)';

describe('writeContextLimit', () => {
  it('overrides BOTH 200000 constants in the CC >=2.1.326 shape (128000 before 32000)', () => {
    const input =
      'q=1;var ept=200000,$L=200000,nV=1e6,rV=1e6,oV=128000,feo=32000;function UL(){}var IYt=200000;';
    const out = writeContextLimit(input);
    expect(out).toBe(
      `q=1;var ept=${OVERRIDE},$L=${OVERRIDE},nV=1e6,rV=1e6,oV=128000,feo=32000;function UL(){}var IYt=200000;`
    );
    expect(writeContextLimit(out!)).toBe(out);
    expect(() => new Function(out + 'return 1;')).not.toThrow();
  });

  it('overrides BOTH 200000 constants in the CC >=2.1.325 shape (two 1e6)', () => {
    const input =
      'q=1;var bat=200000,cD=200000,S1=1e6,E1=1e6,v1=32000,w1=128000;function uD(){}';
    const out = writeContextLimit(input);
    expect(out).toBe(
      `q=1;var bat=${OVERRIDE},cD=${OVERRIDE},S1=1e6,E1=1e6,v1=32000,w1=128000;function uD(){}`
    );
  });

  it('overrides BOTH 200000 constants in the CC >=2.1.305 shape (1e6 in slot 3)', () => {
    const input =
      'q=1;var MCe=200000,c6=200000,n0=1e6,sE=32000,r0=128000;function JR(){}';
    const out = writeContextLimit(input);
    expect(out).toBe(
      `q=1;var MCe=${OVERRIDE},c6=${OVERRIDE},n0=1e6,sE=32000,r0=128000;function JR(){}`
    );
  });

  it('overrides BOTH 200000 constants in the CC >=2.1.21x five-constant shape', () => {
    // CC ~2.1.21x dropped the 20000 constant and appended the 1e6 (1M-context)
    // ceiling; the trailing three must survive verbatim.
    const input =
      'q=1;var _er=200000,bRe=200000,$Rg=32000,URg=128000,jRg=1e6;z=2;';
    const out = writeContextLimit(input);
    expect(out).toBe(
      `q=1;var _er=${OVERRIDE},bRe=${OVERRIDE},$Rg=32000,URg=128000,jRg=1e6;z=2;`
    );
  });

  it('preserves $-prefixed minified identifiers verbatim in the replacement', () => {
    // `$$` and `$1` are special in a String.replace replacement string, so the
    // writer must use a replacer function.
    const input = 'var $a=200000,$$b=200000,$c=32000,$1=128000,$e=1e6;';
    const out = writeContextLimit(input);
    expect(out).toBe(
      `var $a=${OVERRIDE},$$b=${OVERRIDE},$c=32000,$1=128000,$e=1e6;`
    );
  });

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
