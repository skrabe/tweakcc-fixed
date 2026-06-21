import { describe, it, expect, vi } from 'vitest';
import { writeStatuslineUpdateThrottle } from './statuslineUpdateThrottle';

// statusline-update-throttle is opt-in (condition: statuslineThrottleMs != null)
// and replaces CC's flawed debounce with a real throttle (default) or a fixed
// interval. Fixture mirrors the 2.1.21 shape (`X=Gr(()=>O(A),300)`) that the
// regex's first alternation targets; verified against the real function.
const FIXTURE =
  'a=1,O=Pc.useCallback(async(_)=>{w((j)=>({...j,statusLineText:D}))},[w,H,K]),X=Gr(()=>O(A),300);rest';

describe('writeStatuslineUpdateThrottle', () => {
  it('replaces the flawed debounce with a proper throttle (default mode)', () => {
    const out = writeStatuslineUpdateThrottle(FIXTURE);

    expect(out).not.toBeNull();
    expect(out).toContain('lastCall=Pc.useRef(0)');
    expect(out).toContain('Date.now()');
    expect(out).toContain('O(A);'); // still invokes the update fn with its arg
    expect(out).not.toContain('Gr(()=>O(A),300)'); // old debounce removed
  });

  it('uses a fixed setInterval when useFixedInterval is true', () => {
    const out = writeStatuslineUpdateThrottle(FIXTURE, 300, true);

    expect(out).not.toBeNull();
    expect(out).toContain('setInterval(()=>O(argRef.current),300)');
    expect(out).toContain('return()=>clearInterval(id)');
  });

  it('honors a custom interval', () => {
    const out = writeStatuslineUpdateThrottle(FIXTURE, 500);
    expect(out).toContain('>=500');
  });

  it('coerces a non-numeric interval to the default — no code injection (F-90)', () => {
    // settings.misc.statuslineThrottleMs is runtime JSON reachable via untrusted
    // --config-url; a code-bearing string must not splice into the generated code.
    const evil = '1);globalThis.__pwned=1;//' as unknown as number;
    const out = writeStatuslineUpdateThrottle(FIXTURE, evil);
    expect(out).not.toBeNull();
    expect(out).not.toContain('__pwned');
    expect(out).toContain('>=300'); // fell back to the safe default
  });

  it('truncates a fractional interval to an integer', () => {
    const out = writeStatuslineUpdateThrottle(FIXTURE, 250.7);
    expect(out).toContain('>=250');
    expect(out).not.toContain('250.7');
  });

  it('returns null (without throwing) when the throttle pattern is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeStatuslineUpdateThrottle('x=1;function y(){}')).toBeNull();
    errSpy.mockRestore();
  });
});
