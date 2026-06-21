import { describe, it, expect, vi } from 'vitest';
import { writeThinkerSymbolMirrorOption } from './thinkerMirrorOption';

// CC builds the thinking-spinner frame list by appending the reversed list to
// itself so it "bounces": `=[...VAR,...[...VAR].reverse()]`. The patch rewrites
// that splice to either keep the bounce (enableMirror) or drop it (`=[...VAR]`).
// Fixture mirrors that minified shape with a realistic `$`-containing identifier.
const FIXTURE = 'let $f9=[...$f9,...[...$f9].reverse()],z=2;';

describe('writeThinkerSymbolMirrorOption', () => {
  it('keeps the mirrored (bounce) array when enableMirror is true', () => {
    const out = writeThinkerSymbolMirrorOption(FIXTURE, true);
    expect(out).not.toBeNull();
    expect(out).toContain('=[...$f9,...[...$f9].reverse()]');
    // the surrounding code is preserved untouched
    expect(out).toContain('let $f9=');
    expect(out).toContain(',z=2;');
  });

  it('drops the reverse() mirror when enableMirror is false', () => {
    const out = writeThinkerSymbolMirrorOption(FIXTURE, false);
    expect(out).not.toBeNull();
    expect(out).toContain('=[...$f9]');
    expect(out).not.toContain('.reverse()'); // mirror removed
    expect(out).toContain(',z=2;'); // trailing code preserved
  });

  it('returns null (logging) when the mirror shape is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeThinkerSymbolMirrorOption('let q=[...a,...b],z=2;', false)
    ).toBeNull();
    errSpy.mockRestore();
  });
});
