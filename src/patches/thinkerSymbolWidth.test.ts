import { describe, it, expect, vi } from 'vitest';
import { writeThinkerSymbolWidthLocation } from './thinkerSymbolWidth';

// thinker-symbol-width widens the spinner symbol cell. 2.1.172 added an
// "aria-hidden":!0 property before flexWrap; older CC versions emit the bare
// {flexWrap:"wrap",height:1,width:2} object. The patch must preserve whichever
// prefix is present while rewriting width:2 -> width:<config>.
const FIXTURE_ARIA =
  'a=1,$.createElement($k,{"aria-hidden":!0,flexWrap:"wrap",height:1,width:2},z);rest';
const FIXTURE_BARE =
  'a=1,$.createElement($k,{flexWrap:"wrap",height:1,width:2},z);rest';

describe('writeThinkerSymbolWidthLocation', () => {
  it('rewrites width while preserving the 2.1.172 aria-hidden prefix', () => {
    const out = writeThinkerSymbolWidthLocation(FIXTURE_ARIA, 4);

    expect(out).not.toBeNull();
    expect(out).toContain(
      '{"aria-hidden":!0,flexWrap:"wrap",height:1,width:4}'
    );
    // The original width:2 object is gone.
    expect(out).not.toContain(
      '{"aria-hidden":!0,flexWrap:"wrap",height:1,width:2}'
    );
    // Surrounding code untouched.
    expect(out).toContain('a=1,$.createElement($k,');
    expect(out).toContain('},z);rest');
  });

  it('rewrites width on the older bare shape (no aria-hidden prefix)', () => {
    const out = writeThinkerSymbolWidthLocation(FIXTURE_BARE, 3);

    expect(out).not.toBeNull();
    expect(out).toContain('{flexWrap:"wrap",height:1,width:3}');
    // No spurious aria-hidden prefix introduced.
    expect(out).not.toContain('aria-hidden');
    expect(out).not.toContain('width:2');
  });

  it('honors an arbitrary configured width', () => {
    const out = writeThinkerSymbolWidthLocation(FIXTURE_BARE, 10);
    expect(out).toContain('{flexWrap:"wrap",height:1,width:10}');
  });

  it('returns null (logging) when the width shape is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeThinkerSymbolWidthLocation('x=1;function y(){return 1}', 4)
    ).toBeNull();
    errSpy.mockRestore();
  });
});
