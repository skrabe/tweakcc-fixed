import { describe, it, expect, vi } from 'vitest';
import { writeThinkerSymbolSpeed } from './thinkerSymbolSpeed';

// thinkerSymbolSpeed fixes the spinner freezing when
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set, by (a) deleting the
// `if(!J){Z(4);return}` early-bail block and (b) replacing the `120` interval
// with the configured speed. Regex:
//   /(if\(![$\w]+\)\{[$\w]+\(4\);return\})(.{0,200})120\)/
// This fixture mirrors the CC 1.0.24 minified shape from the patch's doc comment.
const FIXTURE = 'WV(()=>{if(!J){Z(4);return}Z((q)=>q+1)},120),rest=2;';

describe('writeThinkerSymbolSpeed', () => {
  it('deletes the early-bail block and swaps 120 for the configured speed', () => {
    const out = writeThinkerSymbolSpeed(FIXTURE, 123456);

    expect(out).not.toBeNull();
    // The if-return early-bail block is removed.
    expect(out).not.toContain('if(!J){Z(4);return}');
    // The body between the block and the interval survives.
    expect(out).toContain('Z((q)=>q+1)}');
    // The 120 interval is replaced by the configured speed, closing paren kept.
    expect(out).toContain('123456)');
    expect(out).not.toContain('120)');
    // Exact reconstructed span: block dropped, interval rewritten in place.
    expect(out).toBe('WV(()=>{Z((q)=>q+1)},123456),rest=2;');
  });

  it('matches the React-Compiler shape with $-bearing minified names (CC 2.1.15)', () => {
    // `l2(CA,120)` form: identifier is `V`, callee is `D`, with a $-name nearby.
    const input =
      'if(!V){D(4);return}D(E$cY)}),(K[17]=V),(K[18]=CA));else CA=K[18];l2(CA,120);';
    const out = writeThinkerSymbolSpeed(input, 999);

    expect(out).not.toBeNull();
    expect(out).not.toContain('if(!V){D(4);return}');
    expect(out).toContain('l2(CA,999)');
    expect(out).not.toContain(',120)');
  });

  it('honors a custom speed value', () => {
    const out = writeThinkerSymbolSpeed(FIXTURE, 5000);
    expect(out).toContain('5000)');
    expect(out).not.toContain('123456');
  });

  it('returns null (without throwing) when the pattern is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeThinkerSymbolSpeed('x=1;function y(){return 120}', 123456)
    ).toBeNull();
    errSpy.mockRestore();
  });

  it('returns null when the early-bail block is present but the 120 interval is too far away', () => {
    // match[2] is bounded to 200 chars; beyond that the shape no longer matches.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const farApart = 'if(!J){Z(4);return}' + 'a'.repeat(250) + '120)';
    expect(writeThinkerSymbolSpeed(farApart, 123456)).toBeNull();
    errSpy.mockRestore();
  });
});
